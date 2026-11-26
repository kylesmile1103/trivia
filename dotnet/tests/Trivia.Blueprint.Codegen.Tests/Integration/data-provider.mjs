import assert from 'node:assert/strict';

import { createDataProvider } from './data-provider.ts';

const base = new URL(process.argv[2]);
const provider = createDataProvider((path, init) => fetch(new URL(path, base), init));
const resource = 'customers';

const customers = [
  { fullName: 'Aria First', email: 'aria@example.test', creditLimit: 10 },
  { fullName: 'Blake Second', email: 'blake@example.test', creditLimit: 20, birthDate: '2000-01-02' },
  { fullName: 'Casey Third', email: 'casey@elsewhere.test', creditLimit: 30 },
];
const inserted = [];
for (const variables of customers) inserted.push((await provider.create({ resource, variables })).data);

const page = await provider.getList({
  resource,
  pagination: { currentPage: 2, pageSize: 1 },
  sorters: [{ field: 'fullName', order: 'desc' }],
});
assert.deepEqual(page.data.map(({ fullName }) => fullName), ['Blake Second']);
assert.equal(page.total, 3);

const cases = [
  ['email', 'eq', 'blake@example.test', [1]],
  ['email', 'ne', 'blake@example.test', [0, 2]],
  ['creditLimit', 'lt', 20, [0]],
  ['creditLimit', 'lte', 20, [0, 1]],
  ['creditLimit', 'gt', 20, [2]],
  ['creditLimit', 'gte', 20, [1, 2]],
  ['email', 'contains', '@example.test', [0, 1]],
  ['email', 'startswith', 'blake', [1]],
  ['email', 'startswith', 'BLAKE', [1]],
  ['email', 'contains', '@EXAMPLE.TEST', [0, 1]],
  ['email', 'in', ['blake@example.test', 'casey@elsewhere.test'], [1, 2]],
  ['birthDate', 'null', true, [0, 2]],
  ['birthDate', 'null', false, [1]],
];
for (const [field, operator, value, indexes] of cases) {
  const found = await provider.getList({
    resource, filters: [{ field, operator, value }], sorters: [{ field: 'fullName', order: 'asc' }],
  });
  assert.deepEqual(found.data.map(({ id }) => id), indexes.map((index) => inserted[index].id), operator);
  assert.equal(found.total, indexes.length, operator);
}

await assert.rejects(
  provider.create({ resource, variables: { fullName: 'Invalid', email: 'wrong' } }),
  (error) => error.statusCode === 400 && Array.isArray(error.errors?.email) && error.errors.email.length > 0,
);
const many = await provider.getMany({ resource, ids: [inserted[0].id, inserted[2].id] });
assert.deepEqual(new Set(many.data.map(({ id }) => id)), new Set([inserted[0].id, inserted[2].id]));

// An edit form sends its own fields only; the members it leaves out keep their values.
const noted = (await provider.create({
  resource, variables: { fullName: 'Drew Fourth', email: 'drew@example.test', status: 'active', notes: 'Prefers email' },
})).data;
const edited = await provider.update({ resource, id: noted.id, variables: { fullName: 'Drew Edited', email: noted.email } });
assert.equal(edited.data.fullName, 'Drew Edited');
const reloaded = (await provider.getOne({ resource, id: noted.id })).data;
assert.deepEqual({ notes: reloaded.notes, status: reloaded.status }, { notes: 'Prefers email', status: 'active' });
