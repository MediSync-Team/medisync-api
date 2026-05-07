import { describe, it, expect } from '@jest/globals';

describe('Dashboard Logic', () => {
  describe('Statistics calculations', () => {
    it('should calculate total appointments', () => {
      const turnos = [
        { id: '1', estado: 'COMPLETADO' },
        { id: '2', estado: 'CANCELADO' },
        { id: '3', estado: 'COMPLETADO' },
        { id: '4', estado: 'CONFIRMADO' },
      ];

      const total = turnos.length;
      expect(total).toBe(4);
    });

    it('should count appointments by estado', () => {
      const turnos = [
        { estado: 'COMPLETADO' },
        { estado: 'CANCELADO' },
        { estado: 'COMPLETADO' },
        { estado: 'CONFIRMADO' },
        { estado: 'RESERVADO' },
      ];

      const countByEstado = (turnos: any[], estado: string) => 
        turnos.filter(t => t.estado === estado).length;

      expect(countByEstado(turnos, 'COMPLETADO')).toBe(2);
      expect(countByEstado(turnos, 'CANCELADO')).toBe(1);
      expect(countByEstado(turnos, 'CONFIRMADO')).toBe(1);
    });

    it('should calculate completion rate', () => {
      const calculateCompletionRate = (turnos: any[]) => {
        const completed = turnos.filter(t => t.estado === 'COMPLETADO').length;
        return turnos.length > 0 ? (completed / turnos.length) * 100 : 0;
      };

      expect(calculateCompletionRate([
        { estado: 'COMPLETADO' },
        { estado: 'COMPLETADO' },
        { estado: 'CANCELADO' },
      ])).toBeCloseTo(66.67, 1);

      expect(calculateCompletionRate([])).toBe(0);
    });

    it('should calculate cancellation rate', () => {
      const calculateCancellationRate = (turnos: any[]) => {
        const cancelled = turnos.filter(t => t.estado === 'CANCELADO').length;
        return turnos.length > 0 ? (cancelled / turnos.length) * 100 : 0;
      };

      expect(calculateCancellationRate([
        { estado: 'COMPLETADO' },
        { estado: 'CANCELADO' },
        { estado: 'CANCELADO' },
      ])).toBeCloseTo(66.67, 1);
    });
  });

  describe('Revenue calculations', () => {
    it('should calculate total revenue', () => {
      const pagos = [
        { monto: 1500, estado: 'APROBADO' },
        { monto: 2000, estado: 'APROBADO' },
        { monto: 1000, estado: 'PENDIENTE' },
      ];

      const totalRevenue = pagos
        .filter(p => p.estado === 'APROBADO')
        .reduce((sum, p) => sum + p.monto, 0);

      expect(totalRevenue).toBe(3500);
    });

    it('should calculate net revenue after fees', () => {
      const pagos = [
        { monto: 1000 },
        { monto: 2000 },
      ];

      const netRevenue = pagos.reduce((sum, p) => {
        return sum + (p.monto * 0.9);
      }, 0);

      expect(netRevenue).toBe(2700);
    });

    it('should group revenue by month', () => {
      const pagos = [
        { monto: 1000, fecha: new Date('2024-01-15') },
        { monto: 2000, fecha: new Date('2024-01-20') },
        { monto: 1500, fecha: new Date('2024-02-10') },
      ];

      const groupByMonth = (pagos: any[]) => {
        const grouped: Record<string, number> = {};
        pagos.forEach(p => {
          const month = `${p.fecha.getFullYear()}-${String(p.fecha.getMonth() + 1).padStart(2, '0')}`;
          grouped[month] = (grouped[month] || 0) + p.monto;
        });
        return grouped;
      };

      const grouped = groupByMonth(pagos);
      expect(grouped['2024-01']).toBe(3000);
      expect(grouped['2024-02']).toBe(1500);
    });
  });

  describe('Patient statistics', () => {
    it('should count unique patients', () => {
      const turnos = [
        { pacienteId: 'p1' },
        { pacienteId: 'p2' },
        { pacienteId: 'p1' },
        { pacienteId: 'p3' },
        { pacienteId: 'p2' },
      ];

      const uniquePatients = new Set(turnos.map(t => t.pacienteId));
      expect(uniquePatients.size).toBe(3);
    });

    it('should calculate average appointments per patient', () => {
      const turnos = [
        { pacienteId: 'p1' },
        { pacienteId: 'p1' },
        { pacienteId: 'p2' },
        { pacienteId: 'p3' },
      ];

      const uniquePatients = new Set(turnos.map(t => t.pacienteId));
      const avgAppointments = turnos.length / uniquePatients.size;

      expect(avgAppointments).toBeCloseTo(1.33, 1);
    });
  });

  describe('Availability management', () => {
    const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    it('should validate availability hours', () => {
      const validateAvailability = (horaInicio: string, horaFin: string) => {
        const [hi, mi] = horaInicio.split(':').map(Number);
        const [hf, mf] = horaFin.split(':').map(Number);
        const startMinutes = hi * 60 + mi;
        const endMinutes = hf * 60 + mf;
        return endMinutes > startMinutes && endMinutes - startMinutes >= 30;
      };

      expect(validateAvailability('09:00', '17:00')).toBe(true);
      expect(validateAvailability('17:00', '09:00')).toBe(false);
      expect(validateAvailability('09:00', '09:00')).toBe(false);
      expect(validateAvailability('09:00', '09:15')).toBe(false);
    });

    it('should get day name from number', () => {
      const getDayName = (diaSemana: number) => DIAS_SEMANA[diaSemana];

      expect(getDayName(0)).toBe('Domingo');
      expect(getDayName(1)).toBe('Lunes');
      expect(getDayName(6)).toBe('Sábado');
    });
  });

  describe('Week navigation', () => {
    it('should get current week dates', () => {
      const getWeekDates = (referenceDate: Date) => {
        const week: Date[] = [];
        const start = new Date(referenceDate);
        start.setDate(start.getDate() - start.getDay());

        for (let i = 0; i < 7; i++) {
          const day = new Date(start);
          day.setDate(start.getDate() + i);
          week.push(day);
        }
        return week;
      };

      const monday = new Date('2024-01-15');
      const week = getWeekDates(monday);

      expect(week.length).toBe(7);
      expect(week[0].getDay()).toBe(0);
      expect(week[6].getDay()).toBe(6);
    });

    it('should navigate to next/previous week', () => {
      const navigateWeek = (currentDate: Date, direction: 'next' | 'prev') => {
        const newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
        return newDate;
      };

      const date = new Date('2024-01-15T12:00:00');
      const nextWeek = navigateWeek(date, 'next');
      const prevWeek = navigateWeek(date, 'prev');
      
      expect(nextWeek.getDate()).toBe(22);
      expect(prevWeek.getDate()).toBe(8);
    });
  });

  describe('Reminders filtering', () => {
    it('should filter active reminders', () => {
      const recordatorios = [
        { id: '1', activo: true, tipo: 'EMAIL' },
        { id: '2', activo: false, tipo: 'PUSH' },
        { id: '3', activo: true, tipo: 'SMS' },
      ];

      const activos = recordatorios.filter(r => r.activo);
      expect(activos.length).toBe(2);
    });

    it('should filter reminders by type', () => {
      const recordatorios = [
        { tipo: 'EMAIL' },
        { tipo: 'PUSH' },
        { tipo: 'EMAIL' },
        { tipo: 'SMS' },
      ];

      const emails = recordatorios.filter(r => r.tipo === 'EMAIL');
      expect(emails.length).toBe(2);
    });

    it('should filter upcoming reminders', () => {
      const now = new Date();
      const recordatorios = [
        { fechaEnvio: new Date(now.getTime() + 3600000), activo: true },
        { fechaEnvio: new Date(now.getTime() - 3600000), activo: true },
        { fechaEnvio: new Date(now.getTime() + 7200000), activo: true },
      ];

      const upcoming = recordatorios.filter(r => 
        r.fechaEnvio > now && r.activo
      );
      expect(upcoming.length).toBe(2);
    });
  });
});
