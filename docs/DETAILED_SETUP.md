# Detailed setup

## Host's IP changes every night

Give the host a name instead of chasing the LAN IP each time:

- **No setup:** most devices already resolve `<hostname>.local` (Bonjour on
  macOS, avahi on Linux) — `http://<hostname>.local:4321`. A few older
  Android phones can't resolve `.local`.
- **A real name (`ps.game`):** needs a DNS override every guest device will
  use — a static DHCP reservation + your router's local DNS (Pi-hole,
  dnsmasq, or a consumer router's "Local DNS" setting). Worth it for a
  recurring game night; skip it for a one-off.
