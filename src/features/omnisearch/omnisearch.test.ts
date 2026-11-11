import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLiveMath, mockOmniQuery, parsePrefix } from "./model.ts";

test("parsePrefix extracts prefix modes 't ', 'c ', 'p ' and cleans queries", () => {
  assert.deepEqual(parsePrefix("t Estudiar unidad 10"), { prefix: "t", cleanQuery: "Estudiar unidad 10" });
  assert.deepEqual(parsePrefix("c Parcial viernes 14:00"), { prefix: "c", cleanQuery: "Parcial viernes 14:00" });
  assert.deepEqual(parsePrefix("p potencial de acción"), { prefix: "p", cleanQuery: "potencial de acción" });
  assert.deepEqual(parsePrefix("Electrónica Digital"), { prefix: "", cleanQuery: "Electrónica Digital" });
});

test("evaluateLiveMath calculates cutoff frequency fc: 1 / (2 * pi * 10k * 100n)", () => {
  const res = evaluateLiveMath("1 / (2 * pi * 10k * 100n)");
  assert.ok(res !== null);
  assert.ok(res.display.includes("159.155 Hz"));
  const num = parseFloat(res.raw_val);
  assert.ok(Math.abs(num - 159.155) < 0.1);
});

test("evaluateLiveMath calculates dB gain: 20 * log10(45)", () => {
  const res = evaluateLiveMath("20 * log10(45)");
  assert.ok(res !== null);
  assert.ok(res.display.includes("33.064 dB"));
});

test("evaluateLiveMath converts bases: 0xFF -> bin, 0b1010 -> hex, 100 -> bin", () => {
  const binRes = evaluateLiveMath("0xFF -> bin");
  assert.ok(binRes !== null);
  assert.equal(binRes.raw_val, "0b11111111");

  const hexRes = evaluateLiveMath("0b1010 -> hex");
  assert.ok(hexRes !== null);
  assert.equal(hexRes.raw_val, "0xA");

  const decToBin = evaluateLiveMath("100 -> bin");
  assert.ok(decToBin !== null);
  assert.equal(decToBin.raw_val, "0b1100100");
});

test("mockOmniQuery creates Google Tasks action for 't ' prefix", () => {
  const results = mockOmniQuery("t Estudiar unidad 10 de Timer");
  assert.equal(results.length, 1);
  assert.equal(results[0].category, "action");
  assert.equal(results[0].icon, "task");
  assert.ok(results[0].title.includes("Estudiar unidad 10"));
  assert.equal(results[0].target, "action:task:Estudiar unidad 10 de Timer");
});

test("mockOmniQuery creates Google Calendar action for 'c ' prefix", () => {
  const results = mockOmniQuery("c Parcial Electromedicina viernes");
  assert.equal(results.length, 1);
  assert.equal(results[0].category, "action");
  assert.equal(results[0].icon, "calendar");
  assert.ok(results[0].title.includes("Parcial Electromedicina"));
  assert.equal(results[0].target, "action:calendar:Parcial Electromedicina viernes");
});

test("mockOmniQuery fuzzy matches apps like 'Electrónica Digital'", () => {
  const results = mockOmniQuery("elctrdig");
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.title === "Electrónica Digital"));
});
