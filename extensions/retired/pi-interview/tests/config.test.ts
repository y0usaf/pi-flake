import { describe, expect, test } from "bun:test";
import { CONFIG_FIELDS, DEFAULT_CONFIG, setConfigField } from "../src/config.ts";

describe("setConfigField", () => {
	test("accepts an in-range integer", () => {
		const result = setConfigField(DEFAULT_CONFIG, "maxQuestions", "5");
		expect(result).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, maxQuestions: 5 } });
	});

	test("rejects an unknown key", () => {
		const result = setConfigField(DEFAULT_CONFIG, "reasoning", "high");
		expect(result.ok).toBe(false);
	});

	test("rejects values outside the declared range", () => {
		expect(setConfigField(DEFAULT_CONFIG, "maxOptions", "1").ok).toBe(false);
		expect(setConfigField(DEFAULT_CONFIG, "maxOptions", "8").ok).toBe(false);
		expect(setConfigField(DEFAULT_CONFIG, "maxOptions", "four").ok).toBe(false);
	});

	test("never mutates the config it was given", () => {
		const before = { ...DEFAULT_CONFIG };
		setConfigField(DEFAULT_CONFIG, "maxQuestions", "1");
		expect(DEFAULT_CONFIG).toEqual(before);
	});

	test("defaults sit inside their own declared range", () => {
		for (const [name, field] of Object.entries(CONFIG_FIELDS)) {
			expect(field.default, name).toBeGreaterThanOrEqual(field.min);
			expect(field.default, name).toBeLessThanOrEqual(field.max);
		}
	});
});
