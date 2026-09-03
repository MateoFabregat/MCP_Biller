import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools/register.js";

const skill = readFileSync(new URL("../skills/biller-consultas/SKILL.md", import.meta.url), "utf8");

describe("contrato vigente de la skill biller-consultas", () => {
  it("no vuelve a las reglas obsoletas de solo lectura ni de fechas", () => {
    expect(skill).not.toMatch(/esta instalación es de solo lectura/i);
    expect(skill).not.toMatch(/fechas concretas/i);
    expect(skill).not.toMatch(/calcular(?:se|las?)?\s+(?:las?\s+)?fechas/i);
  });

  it("explica los tres niveles del modo operativo", () => {
    expect(skill).toMatch(/read_only/);
    expect(skill).toMatch(/write_enabled/);
    expect(skill).toMatch(/BILLER_WRITE_ENABLED=true/);
    expect(skill).toMatch(/dry-run/);
    expect(skill).toMatch(/confirmation_token/);
    expect(skill).toMatch(/allow_production=true/);
  });

  it("exige alias simbólicos y resolución en hora uruguaya", () => {
    for (const alias of [
      "hoy",
      "ayer",
      "mes_actual",
      "mes_pasado",
      "ultimos_7_dias",
      "ultimos_30_dias",
      "ultimos_90_dias",
      "anio_actual",
    ]) {
      expect(skill).toContain(`\`${alias}\``);
    }
    expect(skill).toMatch(/hora uruguaya/i);
    expect(skill).toMatch(/servidor resuelva el rango/i);
  });

  it("mantiene el plan de anulación separado de la operación fiscal", () => {
    expect(skill).toMatch(/biller_plan_anulacion/);
    expect(skill).toMatch(/read_only.*obtiene el comprobante/s);
    expect(skill).toMatch(/cuerpo_sugerido/);
    expect(skill).toMatch(/no anula, no emite/i);
    expect(skill).toMatch(/Nota de Crédito/);
    expect(skill).toMatch(/Nota de Débito/);
    expect(skill).toMatch(/No la describas como reversible/i);
  });

  it("prohíbe mezclar monedas sin conversión autoritativa", () => {
    expect(skill).toMatch(/UYU y USD/);
    expect(skill).toMatch(/nunca se suman ni se comparan/i);
    expect(skill).toMatch(/equivalente_uyu/);
    expect(skill).toMatch(/no inventes ni calcules una tasa/i);
  });

  it("menciona todas las tools registrables en la tabla de intención", () => {
    for (const tool of [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
      expect(skill, `falta ${tool} en la skill`).toContain(tool);
    }
  });
});
