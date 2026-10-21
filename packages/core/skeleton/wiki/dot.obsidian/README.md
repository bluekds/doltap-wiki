Obsidian vault configuration. This directory is committed so every machine shares the same setup.

- The vault root is `wiki/`, not the repository root (keeps node_modules etc. out of the vault)
- Community plugins `dataview` and `obsidian-git` must be installed from Obsidian on first launch (plugin binaries are not committed, only their settings)
- obsidian-git uses `basePath: ".."` so the git root resolves to the repository root
- workspace.json is per-machine state and is gitignored
