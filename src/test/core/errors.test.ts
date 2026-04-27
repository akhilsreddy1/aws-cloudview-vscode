import { describe, it, expect } from 'vitest';
import { classifyError, ErrorCategory } from '../../core/errors';

describe('classifyError', () => {
  it('classifies credential errors', () => {
    const err = new Error('Token expired');
    (err as { name: string }).name = 'ExpiredTokenException';
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.Credentials);
    expect(result.retryable).toBe(true);
  });

  it('classifies throttling errors', () => {
    const err = new Error('Too many requests');
    (err as { name: string }).name = 'ThrottlingException';
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.Throttling);
    expect(result.retryable).toBe(true);
  });

  it('classifies permission errors', () => {
    const err = new Error('Not allowed');
    (err as { name: string }).name = 'AccessDeniedException';
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.Permissions);
    expect(result.retryable).toBe(false);
  });

  it('classifies not-found errors', () => {
    const err = new Error('Resource not found');
    (err as { name: string }).name = 'ResourceNotFoundException';
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.NotFound);
    expect(result.retryable).toBe(false);
  });

  it('classifies network errors from message', () => {
    const err = new Error('getaddrinfo ENOTFOUND some-host');
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.Network);
    expect(result.retryable).toBe(true);
  });

  it('classifies unknown errors', () => {
    const err = new Error('Something unexpected');
    const result = classifyError(err);
    expect(result.category).toBe(ErrorCategory.Unknown);
    expect(result.retryable).toBe(false);
  });

  it('handles non-Error values', () => {
    const result = classifyError('string error');
    expect(result.category).toBe(ErrorCategory.Unknown);
    expect(result.message).toBe('string error');
  });

  it('includes service/action context', () => {
    const err = new Error('fail');
    const result = classifyError(err, { service: 'lambda', action: 'invoke' });
    expect(result.service).toBe('lambda');
    expect(result.action).toBe('invoke');
  });
});
