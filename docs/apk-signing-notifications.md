# APK signing notifications

The existing Bridge sends new, verified APK completions to the same first bot
and global `WECOM_NOTIFY_USER_ID` used by private Sync reports. No Agent
conversation or model call is created, and Sync group delivery is unchanged.

Private Bridge configuration:

```dotenv
APK_NOTIFY_ENABLED=true
APK_NOTIFY_URL=http://127.0.0.1:8767
APK_NOTIFY_API_TOKEN=<dedicated-private-credential>
```

The signing service keeps the matching token and destination fingerprint in
`/opt/patrick-tools/shared/.env`. Download publication and the notification are
committed atomically. The Bridge polls its loopback claim/ack API every five
seconds and persists separate `apkDeliveries` checkpoints in Bridge state.
Offline notifications are retained; expired links and historical completions
are skipped. ACK retries do not resend checkpointed parts, although a crash
between platform acceptance and saving a checkpoint can still duplicate a part.

Messages contain the filename, a download URL ending in that filename and its
Beijing expiry time. Links last three days. Changing the recipient requires
updating the signing service fingerprint; old messages are not rerouted.

Only Bridge JavaScript needs deployment and an idle `wecom-bridge` restart.
The main Agent requires no build or restart. On 2026-11-18 a real GPS APK passed
signing, download verification and delivery to the existing private Sync target;
the signing outbox and Bridge checkpoint both confirmed successful delivery.
A VPS-baseline increment preserved unrelated unpublished local changes.
