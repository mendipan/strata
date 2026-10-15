# Generic contributor inputs

Follow the [local contributor instructions](../../../docs/CONTRIBUTOR_STARTER.md). These complete generic records and readable recipe use existing CLI operations and the compiled `collection-host/1` profile. They contain no external application or private deployment data.

| File | Meaning |
| --- | --- |
| [bootstrap.json](bootstrap.json) | Unvalidated three-Block collection with capacity three and explicit synthetic authority |
| [baseline-composition.json](baseline-composition.json) | No-change candidate to measure and accept before authoring |
| [create-audit.json](create-audit.json) | Parent-assigned creation of an audit Block with collection links and exact criteria |
| [change-limit.json](change-limit.json) | Owned proposal changing capacity from three to five |
| [alternative-limit.json](alternative-limit.json) | Second owner's conflicting capacity proposal; retained as rejected after explicit whole-Layer mediation |
| [changed-composition.json](changed-composition.json) | Consider/select the two exact published proposals |
| [expectations.json](expectations.json) | Literal finite behavior expectations, independent of generated configuration |
| [observe.mjs](observe.mjs) | Executes the chosen generated collection and checks literal observations; supplies no engine evidence or approval |
| [walkthrough.ps1](walkthrough.ps1) | Attended public CLI recipe with contributor-chosen value/Layer IDs, complete considered set, mediated selection, separate synthetic decisions and restart readback |

The checked-in baseline/proposal refs are initial input placeholders. The walkthrough replaces them with the actual returned accepted baseline and draft refs. Do not silently rebase an already created Layer, substitute guessed refs or drop inherited acceptance. A published proposal is not an accepted Release. This is finite in-memory behavior; new collection instances start empty.
