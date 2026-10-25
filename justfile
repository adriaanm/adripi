# adripi maintenance

# shell-syntax check and strict-JSON config validation (the permission config
# is JSONC and validated by its extension)
check:
    bash -n install.sh
    node -e 'for (const f of ["config/pi-auto-review.example.json","config/pi-sandbox.global.example.json","config/pi-sandbox.project.example.json"]) JSON.parse(require("fs").readFileSync(f, "utf8")); console.log("config JSON ok")'

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
