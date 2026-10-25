# adripi maintenance

# shell-syntax check and config validation (the permission config is JSONC)
check:
    bash -n install.sh
    node scripts/check-jsonc.mjs config/*.json

# install packages, check out fork submodules, deploy fork sources
install:
    ./install.sh

# fork branch and pending changes per submodule
forks:
    git submodule foreach --recursive 'git status -sb && git log --oneline -1'

# fetch new upstream tags/commits into the fork clones
update:
    git submodule foreach --recursive 'git fetch origin --tags'

# stage and commit the current setup
commit: check
    git add -A
    git commit -m "update Pi setup"
