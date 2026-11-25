# LLD-11: CRUD admin acceptance slice

- Spec: [011 MVP CRUD admin](../../../specs/011-mvp-crud-admin/spec.md) · FR-MVP-01 through FR-MVP-04
- Existing product contracts: [React codegen](LLD-05-react-codegen.md) and
  [Aspire and the contract loop](LLD-10-aspire-solution-and-contract-loop.md).

## Example blueprint

- ⚑ The example uses the bank contract's `fullName` field and the Vite/Refine conventions
  `/customers/edit/:id` and `/customers/show/:id`. Only the customer and account lists
  appear in the main navigation. The KYC action uses the synced OpenAPI operation ID
  `approveKycCustomer` for the model operation `approveKyc`.
- ⚑ Explicit edit fields start without `notes` so the designer can add it as a single
  edit. The model retains it until the drift scenario. The customer list starts without
  `creditLimit` for the same reason.

## Scripted checks

- ⚑ The Node test and browser harness share a disposable solution setup. It copies only
  the committed Radix kit's UI, hooks, utilities and CSS, and merges its dependencies into
  the generated package. The provider and routes come from the scaffold, and the API
  contract comes from the generated backend. The kit's mock API and contract are unused.
- ⚑ The generated AppHost is started through Aspire.Hosting.Testing with its web resource
  and persistent volume disabled. Aspire allocates the backend ports. The test host reports
  the healthy API endpoint and shuts down when its Node parent's input pipe closes.
