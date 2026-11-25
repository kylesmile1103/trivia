using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class ListQueryEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model)
        => Unit($"{model.Namespace}.Generated", ["System.Globalization", "System.Linq.Expressions", "System.Text.Json"],
            "internal sealed record ListFilter(string Field, string Operator, string Value);",
            "internal sealed record ListSort(string Field, bool Descending);",
            """
            internal static class ListQuery
            {
                internal static int PageNumber(string? text, string field, int fallback, int max)
                {
                    if (text is null)
                        return fallback;
                    if (int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out int value) &&
                        value >= 1 && value <= max)
                        return value;
                    throw Invalid(field, $"Expected an integer from 1 to {max.ToString(CultureInfo.InvariantCulture)}.");
                }

                internal static IEnumerable<ListSort> Sorts(string? sort)
                {
                    if (sort is null)
                        yield break;
                    foreach (string item in sort.Split(','))
                    {
                        bool descending = item.StartsWith('-');
                        string field = descending ? item[1..] : item;
                        if (field.Length == 0)
                            throw Invalid("sort", "A sort field is required.");
                        yield return new(field, descending);
                    }
                }

                internal static IEnumerable<ListFilter> Filters(string[]? filters)
                {
                    foreach (string filter in filters ?? [])
                    {
                        string[] parts = filter.Split(':', 3);
                        if (parts.Length != 3 || parts[0].Length == 0 || parts[1].Length == 0)
                            throw Invalid("filter", "Expected field:operator:value.");
                        yield return new(parts[0], parts[1], parts[2]);
                    }
                }

                internal static IOrderedQueryable<TEntity> Order<TEntity, TKey>(IQueryable<TEntity> query,
                    IOrderedQueryable<TEntity>? ordered, Expression<Func<TEntity, TKey>> key, bool descending)
                    => ordered is null
                        ? (descending ? query.OrderByDescending(key) : query.OrderBy(key))
                        : (descending ? ordered.ThenByDescending(key) : ordered.ThenBy(key));

                internal static string SearchPattern(string text) => "%" + text
                    .Replace("\\", "\\\\", StringComparison.Ordinal)
                    .Replace("%", "\\%", StringComparison.Ordinal)
                    .Replace("_", "\\_", StringComparison.Ordinal) + "%";

                internal static T[] Values<T>(ListFilter filter, Func<string, T> parse)
                {
                    string[] values = filter.Value.Split(',');
                    if (values.Any(string.IsNullOrEmpty))
                        throw BadValue(filter.Field);
                    return values.Select(parse).ToArray();
                }

                internal static int Int32(string text, string field)
                    => int.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out int value)
                        ? value : throw BadValue(field);

                internal static long Int64(string text, string field)
                    => long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long value)
                        ? value : throw BadValue(field);

                internal static decimal Decimal(string text, string field)
                    => decimal.TryParse(text, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent,
                        CultureInfo.InvariantCulture, out decimal value) ? value : throw BadValue(field);

                internal static bool Boolean(string text, string field) => text switch
                {
                    "true" => true,
                    "false" => false,
                    _ => throw BadValue(field)
                };

                internal static DateOnly Date(string text, string field)
                    => DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateOnly value)
                        ? value : throw BadValue(field);

                internal static DateTimeOffset Timestamp(string text, string field)
                    => text.Length >= 20 && text[10] == 'T' && (text.EndsWith('Z') || text[^6] is '+' or '-') &&
                        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTimeOffset value)
                        ? value.ToUniversalTime() : throw BadValue(field);

                internal static Guid Uuid(string text, string field)
                    => Guid.TryParseExact(text, "D", out Guid value) ? value : throw BadValue(field);

                internal static T EnumValue<T>(string text, string field, Func<string, T> parse)
                {
                    try { return parse(text); }
                    catch (JsonException) { throw BadValue(field); }
                }

                internal static ApiProblemException Invalid(string field, string message)
                    => new(400, "Invalid list query.", errors: new Dictionary<string, string[]> { [field] = [message] });

                private static ApiProblemException BadValue(string field)
                    => Invalid("filter", $"Invalid filter value for '{field}'.");
            }
            """);

    internal static string Handler(ModelDocument model, ModelEntity entity, ApiMember[] members)
    {
        string name = entity.Name;
        string key = members[0].Member;
        string filter = FilterMethods(model, entity, members);
        string sorts = string.Join("\n", Allowed(entity, members, entity.Api.Sortable).Select(member =>
            $"{Literal(member.WireName)} => ListQuery.Order(query, ordered, row => row.{member.Member}, term.Descending),"));
        string[] searches = Allowed(entity, members, entity.Api.Searchable).Select(member =>
            $"EF.Functions.ILike(row.{member.Member}!, pattern, {Literal("\\")})").ToArray();
        string search = searches.Length == 0 ? "" : $$"""
            if (!string.IsNullOrEmpty(q))
            {
                string pattern = ListQuery.SearchPattern(q);
                query = query.Where(row => {{string.Join(" || ", searches)}});
            }
            """;

        return $$"""
            private static async Task<Ok<{{name}}Page>> ListAsync(
                [FromQuery] string? page, [FromQuery] string? pageSize, [FromQuery] string? sort,
                [FromQuery(Name = "filter")] string[]? filters, [FromQuery] string? q,
                AppDbContext db, CancellationToken cancellationToken)
            {
                int number = ListQuery.PageNumber(page, "page", 1, int.MaxValue);
                int size = ListQuery.PageNumber(pageSize, "pageSize", 20, 200);
                IQueryable<{{name}}> query = db.{{name}}Set.AsNoTracking();
                foreach (ListFilter filter in ListQuery.Filters(filters))
                    query = ApplyFilter(query, filter);
                {{search}}
                IOrderedQueryable<{{name}}>? ordered = null;
                foreach (ListSort term in ListQuery.Sorts(sort))
                {
                    ordered = term.Field switch
                    {
                        {{sorts}}
                        _ => throw ListQuery.Invalid("sort", $"Unknown sort field '{term.Field}'.")
                    };
                }

                int total = await query.CountAsync(cancellationToken);
                long offset = ((long)number - 1) * size;
                if (offset >= total)
                    return TypedResults.Ok(new {{name}}Page([], total, number, size));

                IOrderedQueryable<{{name}}> stable = ordered is null
                    ? query.OrderBy(row => row.{{key}}) : ordered.ThenBy(row => row.{{key}});
                List<{{name}}> rows = await stable.Skip((int)offset).Take(size).ToListAsync(cancellationToken);
                return TypedResults.Ok(new {{name}}Page(rows.Select(ToResponse).ToArray(), total, number, size));
            }

            {{filter}}
            """;
    }

    private static string FilterMethods(ModelDocument model, ModelEntity entity, ApiMember[] members)
    {
        ApiMember[] allowed = Allowed(entity, members, entity.Api.Filterable).ToArray();
        string arms = string.Join("\n", allowed.Select(member =>
            $"{Literal(member.WireName)} => Filter{member.Member}(query, filter),"));
        string methods = string.Join("\n", allowed.Select(member => FilterMethod(model, entity, member)));
        return $$"""
            private static IQueryable<{{entity.Name}}> ApplyFilter(IQueryable<{{entity.Name}}> query, ListFilter filter)
                => filter.Field switch
                {
                    {{arms}}
                    _ => throw ListQuery.Invalid("filter", $"Unknown filter field '{filter.Field}'.")
                };

            {{methods}}
            """;
    }

    private static string FilterMethod(ModelDocument model, ModelEntity entity, ApiMember member)
    {
        string column = $"row.{member.Member}";
        string present = member.Required ? "" : $"{column} != null && ";
        string element = !member.Required && !member.ReferenceType ? column + ".Value" : column + "!";
        string parse = ParseValue(model, member);
        List<(string Operator, string Predicate)> operations =
        [
            ("eq", $"{column} == value"),
            ("ne", $"{present}{column} != value"),
        ];
        if (member.Type == "string")
        {
            operations.Add(("contains", $"{present}{column}.Contains(value)"));
            operations.Add(("startswith", $"{present}{column}.StartsWith(value)"));
        }
        if (member.Type is "int" or "long" or "decimal" or "DateOnly" or "DateTimeOffset")
        {
            operations.Add(("lt", $"{column} < value"));
            operations.Add(("lte", $"{column} <= value"));
            operations.Add(("gt", $"{column} > value"));
            operations.Add(("gte", $"{column} >= value"));
        }

        string nullBranch = member.Required ? "" : $$"""
            if (filter.Operator == "null")
            {
                bool isNull = ListQuery.Boolean(filter.Value, filter.Field);
                return query.Where(row => ({{column}} == null) == isNull);
            }
            """;
        string accepted = string.Join(" or ", operations.Select(operation => Literal(operation.Operator)));
        string arms = string.Join("\n", operations.Select(operation =>
            $"{Literal(operation.Operator)} => query.Where(row => {operation.Predicate}),"));
        string error = """throw ListQuery.Invalid("filter", $"Operator '{filter.Operator}' is not supported for '{filter.Field}'.")""";

        return $$"""
            private static IQueryable<{{entity.Name}}> Filter{{member.Member}}(IQueryable<{{entity.Name}}> query, ListFilter filter)
            {
                {{nullBranch}}
                if (filter.Operator == "in")
                {
                    {{member.Type}}[] values = ListQuery.Values(filter, text => {{parse}});
                    return query.Where(row => {{present}}values.Contains({{element}}));
                }
                if (filter.Operator is not ({{accepted}}))
                    {{error}};
                string text = filter.Value;
                {{member.Type}} value = {{parse}};
                return filter.Operator switch
                {
                    {{arms}}
                    _ => {{error}}
                };
            }
            """;
    }

    private static string ParseValue(ModelDocument model, ApiMember member)
    {
        if (member.Field?.Enum is string name)
            return $"ListQuery.EnumValue(text, filter.Field, {Enum(model, name)}Values.FromLiteral)";
        return member.Type switch
        {
            "string" => "text",
            "int" => "ListQuery.Int32(text, filter.Field)",
            "long" => "ListQuery.Int64(text, filter.Field)",
            "decimal" => "ListQuery.Decimal(text, filter.Field)",
            "bool" => "ListQuery.Boolean(text, filter.Field)",
            "DateOnly" => "ListQuery.Date(text, filter.Field)",
            "DateTimeOffset" => "ListQuery.Timestamp(text, filter.Field)",
            "Guid" => "ListQuery.Uuid(text, filter.Field)",
            _ => throw new BlueprintInputException([new("invalid_api", ModelLoader.ModelFile, "/entities",
                $"Field {member.WireName} cannot be used as a scalar filter.")])
        };
    }

    private static IEnumerable<ApiMember> Allowed(ModelEntity entity, ApiMember[] members, string[]? names) =>
        (names ?? []).Select(name => members.FirstOrDefault(member => member.WireName == name) ??
            throw new BlueprintInputException([new("dangling_reference", ModelLoader.ModelFile, "/entities",
                $"No field named {name} on {entity.Name}.")]));
}
