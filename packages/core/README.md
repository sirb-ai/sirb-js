# @sirb/core

Load, validate and define [Sirb Agent Spec](https://github.com/sirb-ai/sirb-spec)
`sirb/v1alpha1` documents. Parsing, schema validation and the literal-secret
scan are done by the reference loader in `@sirb/spec`; this package wraps it
in a small typed API and adds a code-first `defineAgent`.

## Load YAML or JSON

```ts
import { loadSpec, loadSpecFile } from "@sirb/core";

const { valid, documents, issues } = loadSpec(yamlText, { format: "yaml" });
if (!valid) {
  for (const i of issues) console.error(i.code, i.instancePath, i.keyword);
}
for (const doc of documents) {
  if (doc.kind === "Agent") console.log(doc.metadata.name, doc.spec.modelBinding);
}

const fromDisk = await loadSpecFile("agents/support.yaml"); // format from the extension
```

`loadSpec` never throws. Every problem is an issue with a `code`, a
`severity` (`error` or `warning`) and the conformance locators
(`instancePath`, `keyword`, `property`, `document`, `line`). A result is valid
when no issue is an error. Warnings, such as a credential-shaped string in
free text, are still reported. Use `loadSpecOrThrow` to get a `SirbSpecError`
instead, and `validateSpec(doc)` to validate an object you already have.
Returned documents are deeply frozen, so nothing changes after validation.

`loadSpecFile` never rejects. It reads only a regular file of at most 1 MiB,
and reads no more than that. Directories, FIFOs, sockets and devices are
`io` issues, and so is a symbolic link unless you pass
`{ followSymlinks: true }`. The symlink check covers only the last path
component, so links in parent directories are still followed.

## Define an Agent in code

```ts
import { defineAgent } from "@sirb/core";

export const supportAgent = defineAgent({
  metadata: { name: "support-agent" },
  spec: {
    modelBinding: "claude-default",
    instructions: "You answer billing questions politely.",
    tools: ["ticket-lookup"],
  },
});
// { apiVersion: "sirb/v1alpha1", kind: "Agent", metadata, spec }, deeply frozen
```

`defineAgent` runs the same checks as the loader: the Agent schema and the
literal-secret scan (SR-SPEC-04). It throws `SirbSpecError` with the same
locators. The result is a plain object, so
`loadSpec(JSON.stringify(supportAgent), { format: "json" })` returns an equal
document. Pass `{ onWarning }` as the second argument to receive warnings.

## What is safe to log

- **Issue `message`** never contains document text. Every loader code has one
  fixed message; a `syntax` message can add a line and column. `schema`
  messages come from the schemas, not from the document.
- **`SirbSpecError.message`** names only codes and locators. A path segment
  that looks like a credential (or is not a short plain name) is shown as `*`.
- **Locator fields** (`instancePath`, `property`) are the document's own keys,
  unmasked. A credential pasted as a key appears there, so treat them like the
  source.

## Conformance

The test suite runs every `@sirb/spec` conformance fixture through this API,
one test per fixture. To print a summary on its own:

```sh
pnpm --filter @sirb/core conformance
```
