---
"@sirb/core": minor
---

Add Sirb Agent Spec v1alpha1 support on top of the `@sirb/spec` reference loader:
`loadSpec`, `loadSpecFile`, `loadSpecOrThrow`, `validateSpec`, `defineAgent` and
`SirbSpecError`, plus TypeScript types for the envelope, Agent, ModelBinding, Tool,
Memory, KnowledgeBase and Policy. Every sirb-spec conformance fixture runs in the test
suite (SR-SPEC-01..04).
