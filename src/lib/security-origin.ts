import { readFileSync } from "node:fs";

// Is a security_alert caused by US? (SECURITY-ALERTS-OURS-1128, owner 2026-11-28:
// « Est-ce que tu peux ne pas envoyer ces alertes si ça vient de toi? »)
//
// ONE place answers it for every producer (key-service, api-service, the box's
// security-watch.py). A producer hands the FACTS it saw in the alert's metadata,
// never a verdict:
//   originIp      the address the action came from (edge client address when it
//                 crossed the edge, else the TCP peer: a docker address)
//   originRelays  "true" when the request acted for someone else (a customer key,
//                 a customer session, an org identity): a box origin is then that
//                 person's act, not ours (the dashboard proxy and the MCP server
//                 call from inside the box on behalf of customers)
//   actorUserId   the internal user id of a signed-in actor, if any
//
// Ours (recorded for Monitoring, marked, never emailed) when:
//   - it is a proof-of-fire replay (`test: "true"`);
//   - the actor is one of our pinned staff TEST accounts;
//   - originIp logged into the box over SSH with one of OUR keys in the last 24 h
//     (the box watcher keeps that list: state/security/staff-ips.json, mounted
//     read-only at /box-security);
//   - originIp is the box itself (loopback, docker networks, the box's public
//     address), relays nobody, AND one of us logged into the box over SSH in the
//     last 2 h. Reaching the inside of the box takes our SSH key, and our agent
//     sessions SSH in all day. The last condition is what keeps the 2026-11-20
//     case loud: that attacker ran code inside the box from a Windmill worker with
//     no SSH login, and key-service (internal only) saw every read as box-local.
// Anything else emails exactly as before. A missing or unreadable staff list
// means nobody is known as ours by address: the alert emails (logged once).
//
// Own module: route tests `vi.mock` their dependencies whole.

/** Our staff TEST accounts (client_service `users.id`), each signed up with an address we own. */
export const STAFF_TEST_USER_IDS: Readonly<Record<string, string>> = {
  "d0855655-d7a4-41b5-af49-e2dd357b60fe": "kevin@pressbeat.io",
  "65581d91-3303-4fba-97c1-ce259a52ebe9": "kevin+invitetest2@distribute.you",
  "3207bfa9-4d8c-4737-9725-53a79350a2a6": "kevin+teamjoiner@distribute.you",
  "e723008b-fa11-48fd-91cc-892ead274ff2": "kevin+teamjoiner@distribute.you",
  "b839c1c9-1106-466f-a691-fedc1db6013d": "probe-onboarding-1002104731@distribute.you",
  "324db643-3744-4316-b117-6f3d3303c199": "kevin.lourd+jlc6@gmail.com",
  "a6317e91-2549-4e96-84e2-a351ee08425e": "kevin.lourd+joinfix2claimer1014@gmail.com",
  "bb5f8639-c59a-4d03-a274-6d4453019c82": "kevin.lourd+jlc7@gmail.com",
  "9687cea5-a904-4978-9a7f-ea9f090c3071": "kevin.lourd+jlcold@gmail.com",
  "d2364c3d-1322-4ac5-ab00-96e692daf257": "kevin.lourd+jlc1@gmail.com",
  "9c0dca14-658b-4a15-9c93-49563daba6de": "kevin.lourd+jlc2@gmail.com",
  "eeee4871-fec3-4614-ab38-9e061fa97168": "kevin.lourd+jlc3@gmail.com",
  "8c09945f-71c7-4d61-af51-4597f5d753c4": "kevin.lourd+joinfixbase1014@gmail.com",
  "2284454a-3cb9-4466-a921-7be5dd314926": "kevin.lourd+joinold1014@gmail.com",
  "be5389a1-0930-459e-8d6a-86512e9c016f": "kevin.lourd+joinnew1014@gmail.com",
  "bea0a521-b2c1-4586-ae5f-4cbfbb3b3e51": "kevin.lourd+jlc4@gmail.com",
  "6bf09789-4f85-4570-83e6-6691a7d74994": "kevin.lourd+jlcfinal@gmail.com",
  "728bf4cc-0cea-412b-9be7-bdb1c7a1eda6": "kevin.lourd+jlcnew@gmail.com",
  "22f42191-0d59-4f83-bf8f-6319989a3354": "kevin.lourd+joinfix2page1014@gmail.com",
  "1e083093-cd6b-449a-b5e9-5d9fd8c8a621": "kevin.lourd+jlc8@gmail.com",
  "d5299b91-f282-4882-8e76-1b2017cf9bea": "kevin.lourd+e2eclient1014@gmail.com",
  "b9b1bdfa-9676-4372-b8cc-791596939265": "kevin+sophietest@distribute.you",
  "e6c602f5-b483-4216-9c8e-9c9b7cbbfd07": "kevin.lourd+agentbase@gmail.com",
  "38959d1a-f847-43c8-830c-985e871a90f5": "kevin.lourd+mobileaudit@gmail.com",
  "19ca5557-b011-4884-b768-2c34f2cdd7b1": "kevin.lourd+mobileaudit2@gmail.com",
  "299cff9b-794d-43ff-a20e-a8898145d7cf": "kevin.lourd+speedaudit@gmail.com",
  "1e4a9596-d165-44f4-a143-91560cc55eb4": "kevin.lourd+speedcheck@gmail.com",
  "25de157e-e9ce-4cf8-992a-ef5b7d9ad3ae": "kevin.lourd+blk1110@gmail.com",
  "dfd18c7a-a480-4ff6-a15a-f70e92d0ed1c": "kevin.lourd+solo1125b@gmail.com",
  "cfc0ef87-236c-4fd5-9dd3-f6100bda52d3": "kevin.lourd+solo1125@gmail.com",
  "53774e4f-2f95-4bb8-942a-d90718c73717": "kevin.lourd+solo1125c@gmail.com",
  "dc828719-cb2b-4b96-b7ee-90d8d3efd893": "kevin.lourd+solo1125d@gmail.com",
  "2b7c40a3-2374-40ee-b0ad-449b92072216": "kevin.lourd+solo1125e@gmail.com",
  "2a4fb053-ddaf-439a-ad5d-1eebe2896a1d": "kevin.lourd+solo1125f@gmail.com",
  "52ad7335-c47d-4130-8672-bc173821e1ce": "kevin.lourd+solo1125g@gmail.com",
  "cd277207-b3ea-4dac-a209-e8b7024bf9b8": "kevin.lourd+solo1125j@gmail.com",
  "b77ee1e0-5568-435f-9bbf-b0c9b9820487": "kevin.lourd+solo1125i@gmail.com",
};

/** The box's own public addresses: a request through the edge from the box itself. */
const BOX_PUBLIC_IPS = ["62.83.93.230"];
const BOX_PUBLIC_IPV6_PREFIXES = ["2a03:4000:13:1c77:"];

export const STAFF_IP_TTL_MS = 24 * 3_600_000;
export const STAFF_SESSION_MS = 2 * 3_600_000;
const RELOAD_MS = 30_000;
const DEFAULT_STAFF_IPS_FILE = "/box-security/staff-ips.json";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bareIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Inside the box: loopback, RFC 1918 (docker bridges), IPv6 loopback / ULA / link-local, or the box's public address. */
export function isBoxIp(ip: string): boolean {
  const v4 = bareIp(ip);
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || BOX_PUBLIC_IPS.includes(v4);
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(lower) ||
    /^fe[89ab][0-9a-f]:/.test(lower) ||
    BOX_PUBLIC_IPV6_PREFIXES.some((p) => lower.startsWith(p))
  );
}

let cache: { at: number; entries: Record<string, number> } | null = null;
let lastReadError: string | null = null;

function staffIpsFile(): string {
  return process.env.SECURITY_STAFF_IPS_FILE?.trim() || DEFAULT_STAFF_IPS_FILE;
}

/** `{ip: lastSeenIso}` written atomically by the box watcher; re-read every 30 s. */
function staffLogins(now: number): Record<string, number> {
  if (cache && now - cache.at < RELOAD_MS) return cache.entries;
  const entries: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(staffIpsFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [ip, seen] of Object.entries(parsed as Record<string, unknown>)) {
        const at = typeof seen === "string" ? Date.parse(seen) : NaN;
        if (Number.isFinite(at)) entries[ip] = at;
      }
    }
    lastReadError = null;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== lastReadError) console.error(`[security-origin] staff IP list unreadable (${staffIpsFile()}), every security alert emails: ${msg}`);
    lastReadError = msg;
  }
  cache = { at: now, entries };
  return entries;
}

/** Tests only. */
export function resetSecurityOriginCache(): void {
  cache = null;
  lastReadError = null;
}

/** Why this security alert was caused by us, or null (then it emails). */
export function ownOriginReason(metadata: Record<string, unknown>, now: number = Date.now()): string | null {
  if (str(metadata.test).toLowerCase() === "true") return "a test replay";

  const userId = str(metadata.actorUserId);
  if (userId && Object.prototype.hasOwnProperty.call(STAFF_TEST_USER_IDS, userId)) {
    return `our staff test account ${STAFF_TEST_USER_IDS[userId]}`;
  }

  const ip = bareIp(str(metadata.originIp));
  if (!ip) return null;
  const logins = staffLogins(now);
  const seen = logins[ip];
  if (seen !== undefined && now - seen < STAFF_IP_TTL_MS) {
    return `${ip} logged into our server with our SSH key in the last 24 h`;
  }
  if (isBoxIp(ip) && str(metadata.originRelays).toLowerCase() !== "true") {
    const lastStaffLogin = Math.max(-Infinity, ...Object.values(logins));
    if (now - lastStaffLogin < STAFF_SESSION_MS) {
      return `from inside our server (${ip}), relaying nobody, while one of us was logged in over SSH`;
    }
  }
  return null;
}
