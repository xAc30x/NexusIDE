# Glossary

**Instant Grep**:
The local exact and regular-expression search every model calls before it reads a file. Nothing from the index is pasted into the prompt.
_Avoid_: Context Engine, semantic_search, IContextService.

**Grep client**:
The reader a query uses. It reports how many documents came from the indexed commit and how many sit in the worktree layer.
_Avoid_: Context Engine.

**Indexer**:
The writer that keeps the indexed commit current and applies pending edits. The next reset is a new Grep client.
_Avoid_: Reindex command.

**Baseline**:
The commit Instant Grep is anchored to.
_Avoid_: HEAD. The baseline can sit behind it.

**Worktree layer**:
User and agent edits on top of the baseline. A query reads the layer its Grep client already holds.

**Direct scan**:
The search used when Instant Grep is off, the folder is not a git checkout, or the index cannot answer. It matches names, and the call still succeeds.
