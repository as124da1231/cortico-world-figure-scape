export type ControlPage = 'home' | 'apps' | 'scene' | 'window';
export type ControlTarget = ControlPage | 'rail';
export type ControlId = 'chat' | 'voice' | 'size' | 'sound' | 'actions' | 'dress' | 'interaction' | 'hoverVisibility' | 'touchRegions' | 'scenes' | 'theme' | 'roam' | 'workbench' | 'through' | 'hide' | 'close' | 'menu' | 'worlds';
export interface ControlSpec { label: [string, string]; icon: string; rail?: boolean; railOnly?: boolean }
export type ControlPages = Record<ControlPage, ControlId[]>;
export interface ControlPanelSize { width: number; height: number }
export interface ControlLayout { pages: ControlPages; rail: ControlId[]; hoverVisible: boolean; panelSize: ControlPanelSize }
export interface ControlLayoutState { layout: ControlLayout; revision: string }
export const CONTROL_COMPONENTS: Record<ControlId, ControlSpec>;
export const CONTROL_SECTIONS: Record<ControlPage, ControlSpec>;
export const CONTROL_PAGE_IDS: readonly ControlPage[];
export const CONTROL_RAIL_LIMIT: number;
export const CONTROL_PANEL_DEFAULT: Readonly<ControlPanelSize>;
export const CONTROL_PANEL_LIMITS: Readonly<{ minWidth: number; maxWidth: number; minHeight: number; maxHeight: number }>;
export function controlPanelSize(value?: unknown): ControlPanelSize;
export function defaultControlLayout(): ControlLayout;
export function allowsControl(id: unknown, target: ControlTarget): id is ControlId;
export function readControlLayout(pages: unknown, rail: string | undefined, visible: boolean | undefined, panelSize?: unknown): ControlLayout;
export function validateControlLayout(input: unknown, panelSize?: ControlPanelSize): ControlLayout;
