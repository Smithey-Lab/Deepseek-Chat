# v0.2 feature acceptance checklist

All 57 entries below are implemented in v0.2. Automated coverage exercises the primary workflows; the remaining controls receive a UI and code review. Provider calls in automated tests use fixtures.

## Repository discovery

1. List repositories accessible to the saved GitHub token.
2. Load additional repository pages instead of silently truncating the account.
3. Search repositories by name and description.
4. Filter repositories by owner.
5. Filter public and private repositories.
6. Hide or show archived repositories.
7. Sort repository choices alphabetically or by recent activity.
8. Display repository description, language, privacy, and default branch.
9. Favorite repositories and retain favorites after restart.
10. Keep a recent-repositories list.
11. Restore the selected repository after restart.
12. List branches with pagination.
13. Browse the default branch when dev is absent; non-dev branches are read-only.
14. Create a missing dev branch from the selected branch after confirmation.
15. Open the selected repository on GitHub.

## Coding workspace

16. Navigate directories using breadcrumbs.
17. Filter the current directory by filename.
18. Show folders first and display file sizes.
19. Show unsaved editor changes explicitly.
20. Revert edits to the loaded original.
21. Reload from GitHub with a dirty-edit guard.
22. Autosave editor drafts locally.
23. Restore editor drafts after restart.
24. Toggle editor word wrapping.
25. Adjust editor font size.
26. Display line and character counts.
27. Insert indentation using Tab.
28. Find the next occurrence of text in the editor.
29. Copy the current file path.
30. Open the current file on GitHub.
31. Summarize changed lines while reviewing a commit.
32. Show recent commit history.
33. Compare dev with the default branch, including ahead/behind counts and changed files.
34. List open pull requests and open them in the browser.
35. Open a prefilled comparison page to prepare a review pull request.

## Conversations

36. Search saved conversations.
37. Rename a conversation.
38. Pin or unpin conversations.
39. Archive conversations and switch to an archive view.
40. Export a conversation as JSON.
41. Export a conversation as Markdown.
42. Import validated conversation JSON without importing credentials.
43. Keep a separate draft message for each conversation.
44. Remember the selected model for each conversation.
45. Retry the last question without duplicating existing messages.
46. Render fenced code safely with individual code-copy buttons.
47. Offer Explain, Review, Tests, and Refactor prompt templates.
48. Display message length and an explicitly approximate token estimate.

## Setup and desktop experience

49. Test the saved GitHub connection.
50. Test the saved DeepSeek connection.
51. Show a first-run setup checklist.
52. Persist a light or dark theme.
53. Toggle compact display density.
54. Provide keyboard shortcuts and an in-app shortcut reference.
55. Show sanitized diagnostics and open the local app-data folder.
56. Enable update actions according to availability/download state and show progress.
57. Keep a bounded local activity history without credentials or file contents.

The app continues to enforce native confirmation and dev-only commits. It does not run generated code, merge pull requests, or read repositories beyond the saved token's permissions. Drafts and conversations remain local readable data; credentials remain encrypted separately.
