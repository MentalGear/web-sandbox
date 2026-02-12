<!--
TODO:
- fill in what sandbox capability or csp connection blocks against what type of access / attack.
- maybe add another matrix to show what access can be used for what attack areas
-->

## Example

| Action                        | Possible? | Requirements                                |
| ----------------------------- | --------- | ------------------------------------------- |
| Create <iframe> element       | ✅ Yes     | allow-scripts                               |
| Load srcdoc content           | ✅ Limited | Content must be inline; no external fetches |
| Load src to external sites    | ❌ No      | Blocked by unique origin + frame-src        |
| Submit forms in nested iframe | ❌ No      | Needs allow-forms (rarely granted)          |
| Navigate top frame            | ❌ No      | Needs allow-top-navigation                  |
| Access cookies/storage        | ❌ No      | Unique origin blocks it                     |
| PostMessage to parent         | ⚠️ Maybe  | Only if allow-same-origin                   |