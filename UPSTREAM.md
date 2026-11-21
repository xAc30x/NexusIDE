# Upstream source

NexusIDE is built on Code - OSS, the open-source core of Visual Studio Code.

| Item | Value |
| --- | --- |
| Upstream repository | https://github.com/microsoft/vscode |
| Release tag | `1.147.0` |
| Commit | `8a14f0cc1b08d531eb83255ea3764ae22aa932b5` |
| Imported on | 2026-11-17 (`1.146.0`, `69047191fc427f2f92828279aae1d90d8eeda7ab`) |
| Updated on | 2026-11-20 |
| License | MIT (see `LICENSE.txt` and `ThirdPartyNotices.txt`) |

The source was copied as a single snapshot commit. Microsoft's git history was not
imported because of its size.

## Files left out of the snapshot

| Path | Reason |
| --- | --- |
| `README.md` | This repository keeps its own README. |
| `.github/workflows/` | Microsoft's CI workflows target Microsoft's private build runners and would fail or queue indefinitely in this repository. NexusIDE CI will be added separately. |
| `extensions/copilot/test/simulation/cache/base.sqlite` | Stored in Git LFS upstream; the LFS content could not be downloaded at import time. Used only by the Copilot simulation tests. |
| `extensions/copilot/test/simulation/cache/layers/225c3482-5729-4633-9555-da6ddb7cbd51.sqlite` | Same as above. |

All other upstream files are unchanged in the import commit. NexusIDE changes are made
in later commits so they can be reviewed separately from the upstream code.

## Updating to a newer upstream release

1. Download the new release tag from https://github.com/microsoft/vscode.
2. Compare it with the tag above and apply the differences in a dedicated commit.
3. Update the table at the top of this file.
