# Instant Grep

One index per git repository, in the common git dir (`git rev-parse --git-common-dir`): `.git/nexus/crepe/<sha>/`. Linked worktrees share that cache. `index.bin` is the sorted hash-to-offset table and the only file mapped into memory. Nexus maps it in the Agent Host utility process, because that process serves the one grep tool. The renderer receives status only: the commit-document count and the worktree-document count.

`security.workspace.trust.enabled` ships off. Off means every folder is trusted and the index may be built. On, Restricted Mode runs no agent, so nothing is indexed and nothing is written under the git dir.

The index is anchored to one git commit. User and agent edits sit in a layer on top of that commit. The index updates incrementally, so there is no periodic rescan and no timer. It rebuilds on its own when the working state has drifted far from the indexed commit. The examples staff give are a big pull and a branch switch.
