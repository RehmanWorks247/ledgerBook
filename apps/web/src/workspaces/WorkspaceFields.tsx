import { workspaceBadgeStyle, type WorkspaceFields as Fields } from "./model";

export function WorkspaceFields({ value, onChange, disabled = false }: {
  value: Fields;
  onChange: (value: Fields) => void;
  disabled?: boolean;
}) {
  const update = (key: keyof Fields, text: string) => onChange({ ...value, [key]: text });
  return (
    <fieldset className="workspace-fields" disabled={disabled}>
      <legend className="sr-only">Workspace details</legend>
      <div className="workspace-identity-preview" aria-hidden="true">
        <span className="workspace-icon" style={workspaceBadgeStyle(value.color)}>{value.name.trim().slice(0, 1).toUpperCase() || "W"}</span>
        <strong>{value.name.trim() || "Your workspace"}</strong>
      </div>
      <label>Workspace name
        <input required maxLength={160} value={value.name} autoComplete="organization"
          onChange={event => update("name", event.target.value)} placeholder="e.g. Northstar Travel" />
      </label>
      <label>Description <span className="workspace-optional">Optional</span>
        <textarea maxLength={1000} rows={2} value={value.description}
          onChange={event => update("description", event.target.value)} placeholder="A short description of this business" />
      </label>
      <div className="workspace-color-field">
        <label>Workspace color
          <input type="color" value={/^#[a-f\d]{6}$/i.test(value.color) ? value.color : "#13795b"}
            onChange={event => update("color", event.target.value)} />
        </label>
        <label>Hex color
          <input value={value.color} maxLength={7} pattern="#[a-fA-F0-9]{6}" required spellCheck={false}
            onChange={event => update("color", event.target.value)} />
        </label>
      </div>
      <p className="small muted workspace-field-hint">This color identifies your workspace. Your personal appearance settings stay the same.</p>
    </fieldset>
  );
}
