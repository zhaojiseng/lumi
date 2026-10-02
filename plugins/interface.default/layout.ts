/** Default desktop chrome geometry; external interface packages may override scoped shell slots. */
export const defaultInterfaceLayout=String.raw`
.desktop-shell{--shell-inset:14px;--sidebar-width:222px;display:grid;grid-template-columns:var(--sidebar-width) minmax(0,1fr);grid-template-rows:58px minmax(0,1fr);column-gap:var(--shell-inset);row-gap:0;padding:0 var(--shell-inset) var(--shell-inset)}
.desktop-shell>.titlebar{position:relative;grid-column:1/-1;grid-row:1;margin:0 calc(-1 * var(--shell-inset));padding:0 calc(2 * var(--shell-inset)) 0 calc(var(--sidebar-width) + var(--shell-inset) + 22px);height:58px;-webkit-app-region:drag}
.titlebar-brand{position:absolute;left:calc(2 * var(--shell-inset));top:0;height:100%;max-width:calc(var(--sidebar-width) - 12px);display:flex;align-items:center;gap:9px;overflow:hidden;color:var(--text);white-space:nowrap;user-select:none}
.titlebar-brand>svg{width:24px;height:24px;flex-shrink:0}.titlebar-brand>strong{font-size:15px;font-weight:650;letter-spacing:-.4px}.titlebar-brand>span{font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis}
.desktop-shell>.sidebar{grid-column:1;grid-row:2;width:auto}
.desktop-shell:where(:not(.platform-darwin))>.sidebar{border-radius:16px}
.desktop-shell>.main-area{grid-column:2;grid-row:2;min-height:0}
.platform-darwin>.titlebar{grid-column:1/-1;margin-left:calc(-1 * var(--shell-inset));padding-left:112px}
.platform-darwin>.sidebar{grid-row:2}
@media(max-width:1250px){.desktop-shell{--shell-inset:10px;--sidebar-width:198px;padding:0 var(--shell-inset) var(--shell-inset);gap:0 var(--shell-inset)}}
`;
