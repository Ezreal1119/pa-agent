#!/usr/bin/env bash
set -euo pipefail

# Installs only fixed Auto-sync units and updates the existing timer helper.
# Does not enable Auto-sync, start Sync, or restart the main Web service.
if [[ ${EUID} -ne 0 ]]; then
  echo 'Run as root on the VPS: sudo bash scripts/install-auto-sync.sh' >&2
  exit 1
fi
cd /opt/ProductExpertCloud
for file in dist/sftp-sync/schedule.js dist/knowledge-sync/auto-sync-cli.js; do
  if [[ ! -f "$file" ]]; then echo 'Build the updated code first: npm run build' >&2; exit 1; fi
done
if [[ $(systemctl show product-expert.service -p LoadState --value) != loaded ]]; then
  echo 'Install product-expert.service first.' >&2; exit 1
fi
web_user=$(systemctl show product-expert.service -p User --value)
web_user=${web_user:-root}
web_group=$(systemctl show product-expert.service -p Group --value)
web_group=${web_group:-$(id -gn "$web_user")}
if [[ ! "$web_user" =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$ || ! "$web_group" =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$ ]]; then
  echo 'The main service uses an unsupported User/Group; configure the Auto-sync unit manually.' >&2; exit 1
fi
install -d -o root -g root -m 0755 /usr/local/libexec \
  /etc/systemd/system/product-expert-sftp.timer.d \
  /etc/systemd/system/product-expert-library-import.timer.d \
  /etc/systemd/system/product-expert-wecom-import.timer.d \
  /etc/systemd/system/product-expert-auto-sync.timer.d \
  /etc/systemd/system/product-expert-auto-sync.service.d \
  /etc/systemd/system/product-expert-sftp-settings.socket.d
install -o root -g root -m 0644 dist/sftp-sync/schedule.js /usr/local/libexec/product-expert-sftp-settings.mjs
install -o root -g root -m 0644 deploy/product-expert-sftp-settings.socket /etc/systemd/system/
install -o root -g root -m 0644 deploy/product-expert-sftp-settings@.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/product-expert-auto-sync.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/product-expert-auto-sync.timer /etc/systemd/system/
printf '[Service]\nUser=%s\nGroup=%s\n' "$web_user" "$web_group" > /etc/systemd/system/product-expert-auto-sync.service.d/90-web-account.conf
chmod 0644 /etc/systemd/system/product-expert-auto-sync.service.d/90-web-account.conf
# Same group as Web; the privileged helper code and its writable paths stay root-owned.
printf '[Socket]\nSocketGroup=%s\nSocketMode=0660\n' "$web_group" > /etc/systemd/system/product-expert-sftp-settings.socket.d/90-web-account.conf
chmod 0644 /etc/systemd/system/product-expert-sftp-settings.socket.d/90-web-account.conf
systemctl daemon-reload
systemctl enable product-expert-sftp-settings.socket
systemctl restart product-expert-sftp-settings.socket
echo 'Auto-sync units installed; its existing enable/disable state was preserved (new installs remain disabled).'
echo 'After current Sync tasks finish: systemctl restart product-expert.service'
echo 'Then open Synchronize → Sync reports → Settings, choose a Beijing time and enable Auto-sync.'
echo 'If the main service overrides AGENT_DATA_DIR outside .env, give product-expert-auto-sync.service the same override.'
