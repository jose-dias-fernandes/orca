# Clear website annotations after delivery

Website notes should disappear after their prompt reaches an agent. Opening a send
menu, copying a prompt, canceling, or failing to deliver must preserve the notes.

## Cause

Both website send menus already use the shared review-note delivery component, but
their success callback only recorded usage. Sidebar target mode did not receive
that callback at all. Other review notes already use a captured delivery callback.

## Design

Reuse `onPromptDelivered` for existing agents, newly launched agents, and sidebar
targets. Capture the page ID and immutable annotation array alongside the prompt.
On acknowledgement, remove only captured objects still present in that page's
store. Extend the existing clear action with an optional delivered snapshot; its
no-snapshot form remains the explicit Clear all action.

The store update is atomic. Updating a note replaces its object, so an edit during
an in-flight send survives. New notes, other pages, and replacements after
navigation survive too. Repeated acknowledgements are harmless. The callback
can finish after the originating menu unmounts and never closes a newer picker.
The existing store subscription removes both markers and tray entries.

## Review and alternatives

Clearing the current page on success is smaller but can erase unsent work. Removing
captured IDs alone still erases edits. Object identity uses the store's existing
immutable update contract without introducing revision counters, persisted delivery
state, another note store, or a transport change. Rehydrated objects are retained
conservatively. This snapshot is process-local and is never serialized.

A generic send-menu refactor is unnecessary: website menus already share delivery
machinery with review notes. Keep their current presentation and add the missing
success semantics at their existing owner.

Local and SSH delivery keep their existing success/error boundary; no connection
failure counts as delivery. Folder workspaces use the same page-scoped state and
require no Git assumptions. No RPC or remote wire format changes are needed.

## Validation

Exercise menu and sidebar acknowledgements, delayed edits/additions, a different
page, repeated acknowledgements, unmount, cancellation, Copy, and explicit Clear
all. Keep the existing shared delivery tests covering success versus failure.
