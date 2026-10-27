# adripi maintenance

# shell syntax and config template validation
check:
    bash -n install.sh
    node scripts/check-configs.mjs

# install packages, deploy both vendored forks, and seed configs
install:
    ./install.sh

# stage and commit the current setup
commit: check
    git add -A
    git commit -m "update Pi setup"
