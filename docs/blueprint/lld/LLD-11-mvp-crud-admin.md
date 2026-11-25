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

## Browser checks

- ⚑ Playwright uses a separate Vite process for the generated app and the existing designer
  proxy. Ports come from `TRIVIA_MVP_APP_PORT` and `TRIVIA_MVP_PORT`, defaulting to 5476 and
  4576. The runtime's unavailability skips the browser checks with the prerequisite message.
- ⚑ The form test changes one outbound payload to bypass the matching client rule. ASP.NET
  returns the real validation response and the test checks that Refine displays it on the
  field and allows the corrected submission.
- ⚑ The inspector edits the show header's Back button in the installed Refine view, which
  owns that JSX. Column and form tests allow just the inserted field or column and its
  required import, then verify that one undo restores the original file bytes.

## Drift scenario

- ⚑ The script uses the Refine tool to add `notes` to the ejected form. It defines
  `CustomerSegment` and removes `notes` in one model patch, then adds `segment` in a
  separate guarded patch so the one-field diff can be measured on its own.
- ⚑ One EF migration includes the new migration and designer files and an update to EF's
  existing model snapshot. The test compares every other backend source file by content.
- ⚑ The browser's drift case starts a second, isolated AppHost on the revised solution and
  forwards the list request to its real API while keeping the Vite and designer ports fixed.
