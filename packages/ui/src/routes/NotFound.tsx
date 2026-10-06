import { Compass } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { navigate } from '../lib/router';

export function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing here"
      description="This route does not exist in the dashboard. Press ? to see every shortcut."
      action={
        <Button variant="secondary" onClick={() => navigate('/')}>
          Back to overview
        </Button>
      }
      className="py-24"
    />
  );
}
