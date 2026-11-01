# adripi maintenance

# shell syntax, config templates, and offline fork-deployment fixtures
check:
    bash -n install.sh
    node scripts/check-configs.mjs
    node --test scripts/deploy-fork.test.mjs

# build the compiled third fork; required before a built-mode deploy
build-subagents:
    node scripts/build-subagents.mjs
    node --test forks/pi-subagents/test/build/child-authority.test.mjs

# real registered child consumers/SDK/IPC; explicit OS/reviewer/provider doubles, no deploy
check-child-composition: build-subagents
    node --test scripts/child-composition.test.mjs

# install packages, deploy the vendored forks, and seed configs
install:
    ./install.sh

# stage and commit the current setup
commit: check
    git add -A
    git commit -m "update Pi setup"
