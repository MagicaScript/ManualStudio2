import '../../src/style.css';
import '../../src/bambu.css';
import { element, icon } from '../../src/ui.ts';
import { installToolbarTooltips } from '../../src/toolbar-tooltips.ts';

const items = [
  { button: element<HTMLButtonElement>('#saveButton'), text: 'Save Project', icon: 'save' },
  { button: element<HTMLButtonElement>('#undoButton'), text: 'Undo (Ctrl+Z)', icon: 'undo' },
  { button: element<HTMLButtonElement>('#redoButton'), text: 'Redo (Ctrl+Y)', icon: 'redo' },
];
items.forEach(item => { item.button.innerHTML = icon(item.icon); });
installToolbarTooltips(items);
