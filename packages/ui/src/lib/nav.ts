import {
  Activity,
  BookOpen,
  Bot,
  GitBranch,
  LayoutDashboard,
  type LucideIcon,
  Route,
  Settings,
  Target,
  Users,
  Workflow,
} from 'lucide-react';

export type PageId =
  | 'library'
  | 'workspace'
  | 'overview'
  | 'accounts'
  | 'traffic'
  | 'routes'
  | 'tasks'
  | 'runner'
  | 'goals'
  | 'settings';

export interface NavItem {
  id: PageId;
  path: string;
  label: string;
  icon: LucideIcon;
  /** Second key of the `g <key>` jump shortcut. */
  key: string;
  group: 'Gateway' | 'Engine' | 'System';
  description: string;
}

export const NAV: NavItem[] = [
  {
    id: 'library',
    path: '/library',
    label: 'Creative library',
    icon: BookOpen,
    key: 'c',
    group: 'Engine',
    description: 'Design guidance, components and studio references',
  },
  {
    id: 'workspace',
    path: '/',
    label: 'Workspace',
    icon: Workflow,
    key: 'w',
    group: 'Engine',
    description: 'Describe your work, make a plan and follow the agents',
  },
  {
    id: 'overview',
    path: '/overview',
    label: 'Overview',
    icon: LayoutDashboard,
    key: 'o',
    group: 'Gateway',
    description: 'Health, token burn and quota pressure',
  },
  {
    id: 'accounts',
    path: '/accounts',
    label: 'Accounts',
    icon: Users,
    key: 'a',
    group: 'Gateway',
    description: 'Provider accounts, limits and status',
  },
  {
    id: 'traffic',
    path: '/traffic',
    label: 'Traffic',
    icon: Activity,
    key: 'r',
    group: 'Gateway',
    description: 'Live requests and failover chains',
  },
  {
    id: 'routes',
    path: '/routes',
    label: 'Routes',
    icon: Route,
    key: 'p',
    group: 'Gateway',
    description: 'Configured routes and their ordered targets',
  },
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    icon: GitBranch,
    key: 't',
    group: 'Engine',
    description: 'Task graph, board and project brain',
  },
  {
    id: 'runner',
    path: '/runner',
    label: 'Runner',
    icon: Bot,
    key: 'e',
    group: 'Engine',
    description: 'Autonomous runner state and live logs',
  },
  {
    id: 'goals',
    path: '/goals',
    label: 'Goals',
    icon: Target,
    key: 'l',
    group: 'Engine',
    description: 'Agent team working toward an objective',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    icon: Settings,
    key: 's',
    group: 'System',
    description: 'Gateway connection, theme and data source',
  },
];

export function pageForPath(path: string): NavItem | undefined {
  return NAV.find((n) => n.path === path);
}
