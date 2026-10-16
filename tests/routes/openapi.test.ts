import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import openapiRoutes from "../../src/routes/openapi.js";

const app = express();
app.use(openapiRoutes);

describe("GET /openapi.json", () => {
  it("returns 200 with a valid OpenAPI spec", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("info");
    expect(res.body.info.title).toBe("Transactional Email Service");
  });

  it("documents lifecycle blind-copy recipients", async () => {
    const res = await request(app).get("/openapi.json");
    const sendRequest = res.body.components.schemas.SendRequest;

    expect(sendRequest.properties.bccEmails).toMatchObject({
      type: "array",
    });
    expect(sendRequest.properties.bccEmails.items).toMatchObject({
      type: "string",
      format: "email",
    });
  });

  it("documents lifecycle visible-copy recipients", async () => {
    const res = await request(app).get("/openapi.json");
    const sendRequest = res.body.components.schemas.SendRequest;

    expect(sendRequest.properties.ccEmails).toMatchObject({
      type: "array",
    });
    expect(sendRequest.properties.ccEmails.items).toMatchObject({
      type: "string",
      format: "email",
    });
    // Optional: a caller that names none is unchanged, so it can never be required
    expect(sendRequest.required ?? []).not.toContain("ccEmails");
  });

  it("documents an optional caller-named reply address", async () => {
    const res = await request(app).get("/openapi.json");
    const sendRequest = res.body.components.schemas.SendRequest;

    expect(sendRequest.properties.replyToEmail).toMatchObject({
      type: "string",
      format: "email",
    });
    expect(sendRequest.required ?? []).not.toContain("replyToEmail");
  });

  it("serves POST /platform-staff-alert with its body contract", async () => {
    const res = await request(app).get("/openapi.json");
    const op = res.body.paths["/platform-staff-alert"]?.post;
    expect(op).toBeDefined();
    const body = res.body.components.schemas.PlatformStaffAlertRequest;
    expect(body.required).toEqual(expect.arrayContaining(["eventType", "eventId", "metadata"]));
    const meta = res.body.components.schemas.SendingDomainBlocklistedMetadata;
    expect(meta.required).toEqual(
      expect.arrayContaining(["domain", "listName", "listedSince", "listAnswer", "mailboxesAffected", "actionTaken", "removalUrl"]),
    );
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "400", "502"]));
  });
});
