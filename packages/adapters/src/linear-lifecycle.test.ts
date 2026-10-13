import { describe, expect, it } from "vitest";
import { linearWebhookUrl } from "./linear-lifecycle.js";

describe("linearWebhookUrl", () => {
  it("builds the callback from a public HTTPS API origin", () => {
    expect(linearWebhookUrl("https://api.example.com", "conn-1")).toBe(
      "https://api.example.com/api/integrations/linear/conn-1/webhook",
    );
    expect(linearWebhookUrl("https://rakazo.example.org:8443/", "conn-2")).toBe(
      "https://rakazo.example.org:8443/api/integrations/linear/conn-2/webhook",
    );
  });

  it.each([
    undefined,
    "",
    "not a url",
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com/?debug=1",
    "https://api.example.com/#frag",
    "https://localhost",
    "https://app.localhost",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://[::1]",
    "https://[2001:db8::1]",
    "https://8.8.8.8",
    "https://intranet",
    "https://rakazo.local",
    "https://rakazo.internal",
    "https://rakazo.lan",
    "https://rakazo.home.arpa",
    "https://host.docker.internal",
  ])("rejects %s", (apiUrl) => {
    expect(linearWebhookUrl(apiUrl, "conn-1")).toBeNull();
  });
});
