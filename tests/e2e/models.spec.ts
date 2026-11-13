import { test } from '@playwright/test';
import { defineModelCacheTests } from '../fixtures/model-cache';

defineModelCacheTests(test);
