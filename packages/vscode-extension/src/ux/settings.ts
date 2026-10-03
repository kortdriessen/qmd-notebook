/**
 * Recommended appearance settings (Spike C outcome). Applied only through an explicit command
 * that previews the exact changes first; nothing is written to user settings on activation.
 */
import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from '../util/config';

export const RECOMMENDED_COLORS: Record<string, string> = {
  'notebook.cellBorderColor': '#80808048',
  'notebook.focusedCellBorder': '#3794ffcc',
  'notebook.inactiveFocusedCellBorder': '#80808080',
  'notebook.selectedCellBorder': '#80808080',
  'notebook.inactiveSelectedCellBorder': '#80808060',
  'notebook.cellEditorBackground': '#80808014',
  'notebook.focusedCellBackground': '#80808010',
  'notebook.selectedCellBackground': '#8080800c',
  'notebook.outputContainerBackgroundColor': '#8080800a',
  'notebook.outputContainerBorderColor': '#80808030',
  'notebook.focusedEditorBorder': '#3794ff66',
};

export interface RecommendedSetting {
  key: string;
  value: unknown;
  reason: string;
}

export function recommendedSettings(): RecommendedSetting[] {
  const current = vscode.workspace.getConfiguration();
  const toolbar = { ...(current.get<Record<string, string>>('notebook.cellToolbarLocation') ?? {}), [NOTEBOOK_TYPE]: 'right' };
  const colors = { ...(current.get<Record<string, unknown>>('workbench.colorCustomizations') ?? {}), ...RECOMMENDED_COLORS };
  return [
    { key: 'notebook.cellFocusIndicator', value: 'border', reason: 'Selected cell shows as a bordered container instead of a gutter bar.' },
    { key: 'notebook.cellToolbarLocation', value: toolbar, reason: 'Compact per-cell toolbar on the right for QMD notebooks.' },
    { key: 'notebook.consolidatedRunButton', value: true, reason: 'One compact run control per cell.' },
    { key: 'notebook.showCellStatusBar', value: 'visible', reason: 'Shows language, execution count/time and QMD status items under each cell.' },
    { key: 'notebook.insertToolbarLocation', value: 'hidden', reason: 'Removes the large "+ Code / + Markdown" bars between cells (use a/b, Alt+Enter or the toolbar).' },
    { key: 'notebook.compactView', value: true, reason: 'Tighter cell margins.' },
    { key: 'notebook.lineNumbers', value: 'off', reason: 'Quieter code cells (toggle with the cell toolbar when needed).' },
    { key: 'notebook.output.scrolling', value: true, reason: 'Long outputs scroll instead of growing without bound.' },
    { key: 'workbench.colorCustomizations', value: colors, reason: 'Subtle 1px cell borders, slightly differentiated editor background, restrained accent on the focused cell (theme-neutral alpha colours).' },
  ];
}

export async function applyRecommendedSettings(): Promise<void> {
  const settings = recommendedSettings();
  const config = vscode.workspace.getConfiguration();
  const changed = settings.filter((s) => JSON.stringify(config.get(s.key)) !== JSON.stringify(s.value));
  if (changed.length === 0) {
    void vscode.window.showInformationMessage('QMD Notebook: recommended appearance settings are already applied.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    changed.map((s) => ({
      label: s.key,
      description: typeof s.value === 'object' ? `→ ${JSON.stringify(s.value).slice(0, 80)}…` : `→ ${JSON.stringify(s.value)}`,
      detail: `${s.reason}  (current: ${JSON.stringify(config.get(s.key)) ?? 'unset'})`,
      picked: true,
      setting: s,
    })),
    { canPickMany: true, title: 'QMD Notebook: preview recommended settings (nothing is written until you confirm)', placeHolder: 'Uncheck anything you do not want changed' },
  );
  if (!picks || picks.length === 0) return;
  const target = await vscode.window.showQuickPick(
    [
      { label: 'Workspace settings', description: '.vscode/settings.json of this workspace', target: vscode.ConfigurationTarget.Workspace },
      { label: 'User settings', description: 'applies to every workspace', target: vscode.ConfigurationTarget.Global },
    ],
    { title: 'Where should these settings be written?' },
  );
  if (!target) return;
  for (const p of picks) {
    await config.update(p.setting.key, p.setting.value, target.target);
  }
  void vscode.window.showInformationMessage(`QMD Notebook: applied ${picks.length} setting(s) to ${target.label.toLowerCase()}.`);
}
