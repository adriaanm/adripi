# adripi maintenance
#
# `just commit` is intentionally a tiny, explicit task: this repo holds
# security-relevant Pi config and a fork, so commits should be deliberate.

# shell-syntax check for the installer
check:
    bash -n install.sh

# stage and commit the current setup
commit: check
    git add -A
    git commit -m "update Pi setup"
