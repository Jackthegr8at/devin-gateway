#!/bin/sh
# Docker DNAT precedes DOCKER-USER: match the ORIGINAL published destination.
# Run after the existing host Docker firewall on every Docker start.
set -eu
gateway_ip=${1:?Supply private gateway IPv4 address}
proxy_ip=${2:?Supply Nginx IPv4 address}
for address in "$gateway_ip" "$proxy_ip"; do
    printf '%s\n' "$address" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || exit 1
done
iptables_bin=/usr/sbin/iptables
# At boot this runs BEFORE Docker creates its chains/starts containers.
"$iptables_bin" -w 5 -N DOCKER-USER 2>/dev/null || "$iptables_bin" -w 5 -S DOCKER-USER >/dev/null
# Insert the deny first: there is never a moment with a broad permit.
for chain in DOCKER-USER INPUT PREROUTING; do
    table=filter
    [ "$chain" != PREROUTING ] || table=raw
    if [ "$chain" = DOCKER-USER ]; then
        set -- -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst "$gateway_ip" --ctorigdstport 38644
    else
        set -- -p tcp -d "$gateway_ip" --dport 38644
    fi
    # Reassert first position even when an older startup hook inserted broad
    # permits above a surviving rule. Insert BEFORE removing old duplicates.
    "$iptables_bin" -w 5 -t "$table" -I "$chain" 1 "$@" ! -s "$proxy_ip" -j DROP
    old_indices=$("$iptables_bin" -w 5 -t "$table" -S "$chain" | awk -v proxy="$proxy_ip/32" -v destination="$gateway_ip" '
        /^-A / { n++; if (n > 1 && index($0, "! -s " proxy " ") &&
            index($0, destination) && index($0, "38644") && /-j DROP$/) print n }
    ' | sort -rn)
    for index in $old_indices; do
        "$iptables_bin" -w 5 -t "$table" -D "$chain" "$index"
    done
done
# Existing private-LAN/Docker rules permit the proxy. All other sources hit
# the destination-specific deny first. Raw PREROUTING additionally protects
# against startup reordering of broad filter permits. No rule is flushed.
