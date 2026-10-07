import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";

describe("validateStepsForActivation — send_template values", () => {
  const issuesFor = (config: Record<string, unknown>) =>
    validateStepsForActivation([
      { step_type: "send_template", step_config: { template_name: "order_ready", ...config } },
    ]);

  it("accepts a template with no extra values", () => {
    expect(issuesFor({})).toEqual([]);
  });

  it("accepts filled variables, header text and an https media link", () => {
    expect(
      issuesFor({
        variables: { "1": "{{ vars.name }}", "2": "#8523" },
        header_text: "Pedido",
        header_media_url: "https://cdn.example.com/a.jpg",
      }),
    ).toEqual([]);
  });

  it("flags a blank body variable by its placeholder number", () => {
    expect(issuesFor({ variables: { "1": "Ana", "2": "  " } })).toEqual([
      { path: "steps[0].variables.2", message: "variable {{2}} is required" },
    ]);
  });

  it("rejects variables that are not an object", () => {
    expect(issuesFor({ variables: ["Ana"] })).toEqual([
      { path: "steps[0].variables", message: "variables must be an object" },
    ]);
  });

  it("flags a blank header text", () => {
    expect(issuesFor({ header_text: "" })).toEqual([
      { path: "steps[0].header_text", message: "header text is required" },
    ]);
  });

  it("requires a literal media link to be https, but allows an empty one", () => {
    expect(issuesFor({ header_media_url: "http://cdn.example.com/a.jpg" })).toEqual([
      {
        path: "steps[0].header_media_url",
        message: "header media link must be an https:// URL",
      },
    ]);
    expect(issuesFor({ header_media_url: "" })).toEqual([]);
  });

    it("accepts button values keyed by index", () => {
    expect(issuesFor({ button_params: { "0": "{{ vars.order }}", "1": "" } })).toEqual([]);
  });

  it("rejects button_params that are not an object", () => {
    expect(issuesFor({ button_params: "x" })).toEqual([
      { path: "steps[0].button_params", message: "button_params must be an object" },
    ]);
  });

  it("rejects a button key that is not an index or a value that is not text", () => {
    // Integer-like keys are enumerated before string keys, whatever the
    // order they were written in — hence "1" is reported before "first".
    expect(issuesFor({ button_params: { first: "x", "1": 5 } })).toEqual([
      { path: "steps[0].button_params.1", message: "button value must be text" },
      { path: "steps[0].button_params.first", message: "button key must be a button index" },
    ]);
  });

  it("leaves a media link with a variable reference for send time", () => {
    expect(issuesFor({ header_media_url: "{{ vars.file }}" })).toEqual([]);
  });
});

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("validates send_buttons / send_list interactive payloads", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [{ id: "yes", title: "Yes" }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [
            { id: "a", title: "A" },
            { id: "b", title: "B" },
            { id: "c", title: "C" },
            { id: "d", title: "D" },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(["steps[0].interactive"]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("accepts keyword_match with a missing match_type (defaults to contains)", () => {
    expect(
      validateTriggerForActivation("keyword_match", { keywords: ["hi"] }),
    ).toEqual([]);
  });

  it("accepts the word match_type (issue #409)", () => {
    // Activation validation has to stay in step with the engine and the
    // builder's dropdown — an automation the UI can save must not be
    // rejected on activation.
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hi"],
        match_type: "word",
      }),
    ).toEqual([]);
  });

  it("requires schedule on time_based triggers", () => {
    expect(validateTriggerForActivation("time_based", {})).toEqual([
      { path: "trigger.schedule", message: "schedule is required" },
    ]);
    expect(
      validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }),
    ).toEqual([]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

    it("requires a destination stage on deal_stage_changed triggers", () => {
    expect(validateTriggerForActivation("deal_stage_changed", {})).toEqual([
      { path: "trigger.to_stage_id", message: "destination stage is required" },
    ]);
    expect(
      validateTriggerForActivation("deal_stage_changed", { pipeline_id: "p1" }),
    ).toEqual([
      { path: "trigger.to_stage_id", message: "destination stage is required" },
    ]);
    expect(
      validateTriggerForActivation("deal_stage_changed", { to_stage_id: "stage-uuid" }),
    ).toEqual([]);
  });

  it("requires reply_ids on interactive_reply triggers", () => {
    expect(validateTriggerForActivation("interactive_reply", {})).toEqual([
      { path: "trigger.reply_ids", message: "at least one reply id is required" },
    ]);
    expect(
      validateTriggerForActivation("interactive_reply", { reply_ids: ["yes", "no"] }),
    ).toEqual([]);
    const empties = validateTriggerForActivation("interactive_reply", {
      reply_ids: ["yes", "  "],
    });
    expect(empties.map((i) => i.message)).toContain(
      "reply ids cannot be empty strings",
    );
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });
});
