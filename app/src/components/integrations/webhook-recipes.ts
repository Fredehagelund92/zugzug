/* webhook-recipes.ts — the verification recipe rendered by
   WebhookVerificationReference.tsx.

   These strings are published developer documentation, so they are kept out of
   the component and exercised by server/src/webhook-recipe.test.ts: that test
   runs NODE_RECIPE against a signature produced by webhook-signing.ts and
   checks the header names below against the dispatcher's real header set.
   Edit here, never inline in the component. */

export const NODE_RECIPE = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody: string, header: string, secret: string): boolean {
  const segments = header.split(",").map((s) => {
    const i = s.indexOf("=");
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()] as const;
  });
  const t = segments.find(([k]) => k === "t")?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex"),
  );
  // A rotation puts one v1 per key in the header — accept any that matches.
  return segments.some(([k, v]) => {
    if (k !== "v1") return false;
    const got = Buffer.from(v.replace(/^sha256=/, ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}`;

export const PYTHON_RECIPE = `import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    segments = [p.split("=", 1) for p in header.split(",")]
    t = next((v for k, v in segments if k == "t"), None)
    if t is None or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(
        secret.encode(),
        f"{t}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    # A rotation puts one v1 per key in the header — accept any that matches.
    return any(
        k == "v1" and hmac.compare_digest(v.removeprefix("sha256="), expected)
        for k, v in segments
    )`;

export const GO_RECIPE = `package zugzug

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "math"
    "strconv"
    "strings"
    "time"
)

func Verify(rawBody []byte, header, secret string) bool {
    var stamp string
    var sigs []string
    for _, p := range strings.Split(header, ",") {
        kv := strings.SplitN(p, "=", 2)
        if len(kv) != 2 {
            continue
        }
        switch strings.TrimSpace(kv[0]) {
        case "t":
            stamp = strings.TrimSpace(kv[1])
        case "v1":
            sigs = append(sigs, strings.TrimPrefix(strings.TrimSpace(kv[1]), "sha256="))
        }
    }
    t, err := strconv.ParseInt(stamp, 10, 64)
    if err != nil || math.Abs(float64(time.Now().Unix()-t)) > 300 {
        return false
    }
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(stamp + "." + string(rawBody)))
    expected := mac.Sum(nil)
    // A rotation puts one v1 per key in the header — accept any that matches.
    for _, s := range sigs {
        if raw, err := hex.DecodeString(s); err == nil && hmac.Equal(raw, expected) {
            return true
        }
    }
    return false
}`;

/** A real delivery, headers exactly as the dispatcher sends them. */
export const EXAMPLE_REQUEST = `POST /your-endpoint HTTP/1.1
Host: your-app.example
content-type: application/json
user-agent: zugzug-webhook/1
x-zugzug-event: table.published
x-zugzug-event-id: evt_9f2c4b1d7a3e5c80
x-zugzug-delivery: whd_0f8e3a7c2d6b4c1f9a4e7b8c1d2e3f40
x-zugzug-signature: t=1718457600,kid=current,v1=sha256=4f8a1e…
x-zugzug-test: 0

{"dim_slug":"country","dim_label":"Country","version":12,"previous_version":11,
 "committed_by":{"id":"u_7f3a","name":"Mia"},
 "changes":{"added":[{"key":"DE","label":"Germany"}],
            "remapped":[],"updated":[],"merged":[],"retired":[]},
 "summary":{"added":1,"remapped":0,"updated":0,"merged":0,"retired":0},
 "kind":"publish"}`;

/** Header carried during the 24h grace after a rotation: one signature per key. */
export const EXAMPLE_ROTATION_SIGNATURE = `x-zugzug-signature: t=1718457600,kid=current,v1=sha256=4f8a1e…,kid=previous,v1=sha256=91b7dc…`;
