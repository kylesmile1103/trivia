# LLD-11: CRUD admin acceptance slice

- Spec: [011 MVP CRUD admin](../../../specs/011-mvp-crud-admin/spec.md) · FR-MVP-01 through FR-MVP-04
- Existing product contracts: [React codegen](LLD-05-react-codegen.md) and
  [Aspire and the contract loop](LLD-10-aspire-solution-and-contract-loop.md).

## Example blueprint

- ⚑ The example uses the bank contract's `fullName` field and the Vite/Refine conventions
  `/customers/edit/:id` and `/customers/show/:id`. Only the customer and account lists
  appear in the main navigation.
- ⚑ Explicit edit fields start without `notes` so the designer can add it as a single
  edit. The model retains it until the drift scenario. The customer list starts without
  `creditLimit` for the same reason.
