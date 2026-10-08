# @trivia/openapi-inferencer

A drop-in, contract-driven replacement for Refine's `@refinedev/inferencer`.

Refine's inferencer guesses a page at runtime from one live record:
- it shows nothing for an empty table;
- it can't see bounds or enums;
- its code ends in a copy-paste modal.

This one gets the page from your **OpenAPI contract**, through Trivia's dev server. The page
runs live in your app before any file exists, even with no records, and **Eject to disk**
writes it and switches the route over, as one undo entry.

```tsx
import { OpenApiListInferencer, OpenApiShowInferencer } from "@trivia/openapi-inferencer";

<Route path="/customers" element={<OpenApiListInferencer />} />
<Route path="/customers/show/:id" element={<OpenApiShowInferencer hideFields={["notes"]} />} />
```

It needs:
- Refine 5 (it reads the route's resource with `useResourceParams`);
- `@trivia/vite-plugin-ast-locator` in the app's Vite plugins;
- `trivia.manifest.json` from `@trivia/contract-sync`.

## Props

| Prop | |
| --- | --- |
| `resource` | The Refine resource (`customers`) or the contract's (`Customer`). Default: the route's. |
| `ejectPath` | Where Eject writes the page, under `src/`. Default: next to the other pages. |
| `hideFields` | Contract fields to leave out. |
| `title` | The page's title. |

## How it works

- The page is the code Trivia's generator writes (`docs/product.md`, slices 4–6): `useTable`,
  `useForm` with zod rules and the contract's bounds, and `useShow`. Forms are written in your
  project's style: shadcn's `Field` or Refine's `<FormField>`.
- The dev server serves that code as a module (`/@trivia/preview/<id>.tsx`), which Vite compiles
  with your aliases and components. What you see is what Eject writes; the only extra is a
  stylesheet with the page's Tailwind classes, since Tailwind only finds classes in files on disk.
- Eject asks the dev server to write the file and to swap the inferencer element for the page's
  component (the plugin stamps every element with its source location). Trivia's undo takes both
  back.

In a production build it renders a notice instead: eject your pages before building.
