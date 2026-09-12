import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { DashboardRoute, Shell } from './App';

vi.mock('@clerk/react/internal', () => ({
  publishableKeyFromHost: () => 'test-publishable-key',
}));

const testUser = {
  id: 'user-test',
  name: 'Test Operator',
  email: 'operator@example.com',
  role: 'analyst' as const,
  organisation: {
    id: 'org-test',
    name: 'Test Operations',
    code: 'TEST-OPS',
  },
};

function ThrowingDashboard(): never {
  throw new Error('dashboard render failed');
}

describe('dashboard screen boundary', () => {
  it('keeps the application shell rendered when the dashboard fails during render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(
        <Router hook={memoryLocation({ path: '/dashboard' }).hook}>
          <Shell user={testUser}>
            <DashboardRoute>
              <ThrowingDashboard />
            </DashboardRoute>
          </Shell>
        </Router>,
      );

      expect(screen.getByText('Dashboard could not be displayed safely.')).toBeTruthy();
      expect(screen.getByTestId('link-logo')).toBeTruthy();
      expect(screen.getByText('Overview')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });
});