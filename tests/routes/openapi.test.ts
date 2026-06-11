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
});
