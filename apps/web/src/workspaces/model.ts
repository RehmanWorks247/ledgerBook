import type { CSSProperties } from "react";
import { mutate } from "../api";

export const DEFAULT_WORKSPACE_COLOR = "#13795b";

export type WorkspaceFields = {
  name: string;
  description: string;
  color: string;
};

export type Workspace = WorkspaceFields & {
  id: string;
  currency: string;
  currency_exponent: number;
  version: number;
  created_at: string;
  updated_at: string;
};

export function workspaceFields(workspace?: Partial<WorkspaceFields>): WorkspaceFields {
  return {
    name: workspace?.name ?? "",
    description: workspace?.description ?? "",
    color: workspace?.color ?? DEFAULT_WORKSPACE_COLOR,
  };
}

const fieldLimits = {
  name: 160, description: 1000,
} as const;
const fieldLabels: Record<keyof typeof fieldLimits, string> = {
  name: "Workspace name", description: "Description",
};

export function validateWorkspaceFields(fields: WorkspaceFields): WorkspaceFields {
  const value = Object.fromEntries(Object.entries(fields).map(([key, text]) => [key, text.trim()])) as WorkspaceFields;
  if (!value.name) throw new Error("Enter a workspace name.");
  for (const [field, limit] of Object.entries(fieldLimits)) {
    const key = field as keyof typeof fieldLimits;
    if (value[key].length > limit) throw new Error(`${fieldLabels[key]} must be ${limit} characters or fewer.`);
  }
  if (!/^#[a-f\d]{6}$/i.test(value.color)) throw new Error("Choose a valid workspace color.");
  value.color = value.color.toLowerCase();
  return value;
}

// A validated color is only applied to the workspace badge, never the user's theme.
export function workspaceBadgeStyle(color?: string | null): CSSProperties | undefined {
  if (!color || !/^#[a-f\d]{6}$/i.test(color)) return undefined;
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return { backgroundColor: color, color: luminance > 0.179 ? "#000000" : "#ffffff" };
}

export async function deleteWorkspace(workspace: Pick<Workspace, "id" | "name" | "version">, confirmation: string) {
  if (confirmation !== workspace.name) throw new Error("Enter the workspace name exactly to confirm deletion.");
  return mutate<{ id: string; deleted: true; files_pending?: number }>(`/organizations/${encodeURIComponent(workspace.id)}`, {
    confirmation_name: confirmation,
    expected_version: workspace.version,
  }, "DELETE");
}
