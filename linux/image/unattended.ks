# An unattended Herald OS install: boot the installer ISO with inst.ks=<url of this file>.
# It wipes the first disk and encrypts it; change the passphrase (or remove --passphrase to be asked).
text
lang en_US.UTF-8
keyboard us
timezone UTC --utc
zerombr
clearpart --all --initlabel --disklabel=gpt
autopart --type=btrfs --encrypted --passphrase=change-me
# The image itself; the installer ISO points this at the image it was built from.
ostreecontainer --url=ghcr.io/iamlukethedev/herald-os:stable
# The first boot creates the session user; the shell's setup sets the name and password.
rootpw --lock
# The login screen needs graphical.target, which Anaconda does not pick for greetd by itself.
xconfig --startxonboot
reboot
