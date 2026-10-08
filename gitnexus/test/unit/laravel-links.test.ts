import { describe, expect, it } from 'vitest';
import {
  buildViewIndex,
  extractTestRouteCalls,
  extractViewReferences,
  resolveViewPath,
} from '../../src/core/ingestion/route-extractors/laravel-links.js';

const NAMED = new Map([
  ['sales.index', '/sales'],
  ['sales.show', '/sales/{sale}'],
]);

const urls = (content: string): string[] =>
  extractTestRouteCalls('tests/Feature/SaleTest.php', content, NAMED).map((c) => c.fetchURL);

describe('extractTestRouteCalls', () => {
  it('resolves named routes, with or without parameters', () => {
    expect(
      urls(`$this->get(route('sales.index'));
            $this->post(route('sales.show', $sale), []);`),
    ).toEqual(['/sales', '/sales/{sale}']);
  });

  it('reads literal paths from HTTP test helpers', () => {
    expect(
      urls(`$this->get('/login');
            $this->actingAs($u)->postJson('/api/sales?page=2', []);
            $this->json('DELETE', '/api/sales/1');
            $browser->visit('/dashboard');`),
    ).toEqual(['/login', '/api/sales', '/api/sales/1', '/dashboard']);
  });

  it('skips unknown names and interpolated paths, and de-duplicates', () => {
    expect(
      urls(`$this->get(route('nope'));
            $this->get("/sales/{$sale->id}");
            $this->get('/login'); $this->get('/login');`),
    ).toEqual(['/login']);
  });
});

describe('extractViewReferences', () => {
  it('finds views rendered from PHP', () => {
    expect(
      extractViewReferences(
        'app/Http/Controllers/SaleController.php',
        `return view('sales.index', $data);
         return View::make('sales/show');
         return $this->view('mail.receipt');
         Route::view('/about', 'pages.about');
         $x = preview('not.a.view'); $y->overview('nor.this');`,
      ),
    ).toEqual(['sales.index', 'sales/show', 'mail.receipt', 'pages.about']);
  });

  it('finds includes, layouts, components and Livewire tags in Blade', () => {
    expect(
      extractViewReferences(
        'resources/views/sales/index.blade.php',
        `@extends('layouts.app')
         @include('sales.partials.row', ['s' => $s])
         @includeWhen($show, 'sales.partials.total')
         <x-forms.input name="q" /> <x-alert/>
         <livewire:sales.table /> @livewire('sales.filter')`,
      ),
    ).toEqual([
      'layouts.app',
      'sales.partials.row',
      'sales.partials.total',
      'components.forms.input',
      'components.alert',
      'livewire.sales.table',
      'livewire.sales.filter',
    ]);
  });

  it('ignores Blade-only syntax in plain PHP files', () => {
    expect(extractViewReferences('app/Foo.php', `// @include('a.b') <x-alert/>`)).toEqual([]);
  });
});

describe('view resolution', () => {
  const index = buildViewIndex([
    'resources/views/sales/index.blade.php',
    'resources/views/components/alert.blade.php',
    'resources/views/components/card/index.blade.php',
    'app/Models/Sale.php',
    'modules/billing/resources/views/invoice.blade.php',
  ]);

  it('maps dotted and slashed names to files', () => {
    expect(resolveViewPath('sales.index', index)).toBe('resources/views/sales/index.blade.php');
    expect(resolveViewPath('sales/index', index)).toBe('resources/views/sales/index.blade.php');
    expect(resolveViewPath('invoice', index)).toBe(
      'modules/billing/resources/views/invoice.blade.php',
    );
  });

  it('resolves a component folder to its index view', () => {
    expect(resolveViewPath('components.card', index)).toBe(
      'resources/views/components/card/index.blade.php',
    );
  });

  it('leaves namespaced and unknown views unresolved', () => {
    expect(resolveViewPath('billing::invoice', index)).toBeUndefined();
    expect(resolveViewPath('nope', index)).toBeUndefined();
  });
});
