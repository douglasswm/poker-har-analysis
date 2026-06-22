/* Single-threaded stub for <omp.h>: lets TexasSolver build without OpenMP.
   #pragma omp lines are ignored by the compiler when -fopenmp is absent, so the
   solver runs sequentially. The few omp_* calls resolve to these no-ops. */
#ifndef TENGAN_OMP_STUB_H
#define TENGAN_OMP_STUB_H
static inline int  omp_get_num_procs(void)   { return 1; }
static inline int  omp_get_thread_num(void)  { return 0; }
static inline int  omp_get_num_threads(void) { return 1; }
static inline int  omp_get_max_threads(void) { return 1; }
static inline void omp_set_num_threads(int n){ (void)n; }
#endif
