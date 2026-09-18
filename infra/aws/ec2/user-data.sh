#!/bin/bash
# First boot only: Docker, the data disk, and the first `up.sh`.
# Later deploys run up.sh through SSM Run Command (scripts/deploy.sh), so this
# file never needs to change on a running instance.
# ${bucket} and ${region} are filled by Terraform's templatefile(), not by bash.
# shellcheck disable=SC2154
set -euo pipefail
exec > >(tee -a /var/log/wattsteer-bootstrap.log) 2>&1

dnf install -y docker
systemctl enable --now docker

# Compose v2 plugin for arm64: Amazon Linux 2023 does not package it.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-aarch64"
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# The data volume is attached after launch; on Nitro instances ${data_device}
# shows up as an NVMe disk. Wait for the disk that is not the root one.
root_disk="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")"
for _ in $(seq 1 60); do
  data_disk="$(lsblk -dno NAME,TYPE | awk -v root="$root_disk" '$2 == "disk" && $1 != root { print $1; exit }')"
  [ -n "$data_disk" ] && break
  sleep 5
done
[ -n "$data_disk" ] || { echo "data volume never appeared"; exit 1; }

# Format only a blank disk: a reattached volume keeps its data.
if ! blkid "/dev/$data_disk" >/dev/null 2>&1; then
  mkfs.ext4 -L wattsteer-data "/dev/$data_disk"
fi
mkdir -p /data
grep -q "LABEL=wattsteer-data" /etc/fstab || echo "LABEL=wattsteer-data /data ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a

mkdir -p /opt/wattsteer
aws s3 cp "s3://${bucket}/deploy/up.sh" /opt/wattsteer/up.sh --region "${region}"
chmod +x /opt/wattsteer/up.sh
/opt/wattsteer/up.sh latest "${bucket}" || echo "first up.sh failed; the deploy will run it again"
