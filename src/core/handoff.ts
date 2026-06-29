import { formatCost, type CostCurrency } from "./cost.js";

export interface HandoffMarkdownData {
  sessionName: string;
  branch: string;
  diff: string;
  costUSD?: number;
  currency?: CostCurrency;
  exchangeRate?: number;
  claudeMdContent?: string;
  todos?: string[];
  gitLog?: string;
}

export interface HandoffMarkdownOptions {
  date?: Date;
  fenceDiff?: boolean;
}

export function buildHandoffMarkdown(
  data: HandoffMarkdownData,
  opts: HandoffMarkdownOptions = {},
): string {
  const date = (opts.date ?? new Date()).toISOString();
  const parts: string[] = [
    `# ccmux handoff: ${data.sessionName}`,
    ``,
    `- date: ${date}`,
    `- branch: ${data.branch}`,
  ];

  if (data.costUSD != null) {
    parts.push(`- cost: ${formatCost(data.costUSD, data.currency, data.exchangeRate)}`);
  }

  parts.push(``, `## diff summary`, ``);
  if (opts.fenceDiff) {
    parts.push(`\`\`\``, data.diff || "(no changes)", `\`\`\``);
  } else {
    parts.push(data.diff || "(no changes)");
  }

  if (data.gitLog) {
    parts.push(``, `## git log`, ``, `\`\`\``, data.gitLog, `\`\`\``);
  }

  if (data.todos && data.todos.length > 0) {
    parts.push(``, `## todos`, ``);
    for (const todo of data.todos) {
      parts.push(`- [ ] ${todo}`);
    }
  }

  if (data.claudeMdContent) {
    parts.push(``, `## CLAUDE.md`, ``, data.claudeMdContent);
  }

  parts.push(``);
  return parts.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}
