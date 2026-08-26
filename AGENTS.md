# Project UI Guidelines

## Information hierarchy and repetition

- Every visible fact, status, count, title, or error should have one authoritative location on a page.
- Do not repeat the same text in a page title, card title, summary row, helper copy, modal, or toast. Parent areas provide context; child areas provide the action or detail.
- Navigation labels may identify the current location, but must not repeat nearby page content or status values.
- Keep different concepts separate even when their wording is similar. For example, door state and lock state are distinct; the same lock state repeated in three places is not.
- Before completing a UI change, audit the surrounding page for duplicated headings, values, explanatory text, counts, and feedback—not only the edited component.

## Feedback and notifications

- All transient feedback—including form validation, modal errors, row-operation errors, page errors, and success messages—must use the single top-right global notification.
- Do not render transient feedback inline inside forms, cards, rows, or modals. Static field instructions and permanent explanatory copy are not notifications and may remain local.
- Error notifications remain until the user closes them. Never auto-dismiss errors.
- Success notifications dismiss automatically after a short delay and may also include a manual close button.
- Only one notification may be visible at a time. Use one priority order for error sources and never render the same message in another location.

## Form controls

- Never render a browser-native `select` in the product UI. All dropdown choices must use the shared custom select component so triggers, menus, arrows, selected states, and keyboard behavior remain consistent.
- Custom dropdowns must support pointer interaction, outside-click closing, Arrow Up/Down navigation, Home/End, Enter, Escape, and visible keyboard focus.

## Review checklist

- Confirm every transient message is owned by the top-right notification and appears nowhere else.
- Confirm dangerous actions are separated from routine actions in both placement and styling.
- Confirm status summaries do not repeat the same value already shown in the page header or card body.
- Confirm errors persist until acknowledged and successes clear automatically.
- Confirm new choice fields reuse the shared custom select and do not introduce native browser dropdowns.
