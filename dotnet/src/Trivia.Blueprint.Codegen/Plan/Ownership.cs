using System.IO.Enumeration;

namespace Trivia.Blueprint.Codegen.Plan;

internal static class Ownership
{
    internal static string Resolve(string root, string relative, bool directory = false)
    {
        string[] parts = relative.Split('/');
        if (parts.Any(part => part.Length == 0 || part is "." or ".." ||
            part.IndexOfAny(['\\', ':', '\0']) >= 0 || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
            throw new IOException("The path must stay inside --root.");

        RequireSafe(root, directory: true);
        string current = root;
        for (int i = 0; i < parts.Length; i++)
        {
            current = Path.Combine(current, parts[i]);
            RequireSafe(current, directory || i < parts.Length - 1);
        }
        return current;
    }

    internal static FileAttributes? Attributes(string path)
    {
        try
        {
            return File.GetAttributes(path);
        }
        catch (IOException exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    internal static IEnumerable<string> GeneratedPaths(string root, string apiDirectory)
    {
        string apiPath = Resolve(root, apiDirectory, directory: true);
        foreach (string subdirectory in new[] { "Data", "Enums", "Features", "Generated" })
        {
            string directory = Path.Combine(apiPath, subdirectory);
            FileAttributes? attributes = Attributes(directory);
            if (attributes is null || attributes.Value.HasFlag(FileAttributes.ReparsePoint) ||
                !attributes.Value.HasFlag(FileAttributes.Directory))
                continue;
            foreach (string file in Enumerate(directory, subdirectory == "Features"))
                yield return Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/');
        }
    }

    private static FileSystemEnumerable<string> Enumerate(string directory, bool recursive) =>
        new(directory, (ref FileSystemEntry entry) => entry.ToFullPath(),
            new EnumerationOptions
            {
                RecurseSubdirectories = recursive,
                AttributesToSkip = FileAttributes.ReparsePoint,
                IgnoreInaccessible = false
            })
        {
            ShouldIncludePredicate = (ref FileSystemEntry entry) =>
                !entry.IsDirectory && entry.FileName.EndsWith(".g.cs", StringComparison.Ordinal),
            ShouldRecursePredicate = (ref FileSystemEntry entry) =>
                (entry.Attributes & FileAttributes.ReparsePoint) == 0
        };

    private static void RequireSafe(string path, bool directory)
    {
        if (Attributes(path) is not FileAttributes attributes)
            return;
        if (attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Symbolic links are forbidden in output paths.");
        if (directory != attributes.HasFlag(FileAttributes.Directory))
            throw new IOException(directory ? "An output directory is occupied by a file." :
                "An output file is occupied by a directory.");
    }
}
