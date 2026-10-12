import './styles.css';
import { mountAuthorStudio } from '../src/ui/app.js';

const root = document.getElementById('app');
if (!root) throw new Error('UI root not found');
mountAuthorStudio(root);
