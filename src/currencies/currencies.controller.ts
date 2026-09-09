import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrenciesService } from './currencies.service';
import { CreateCurrencyDto } from './dto/create-currency.dto';

@ApiTags('العملات')
@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'العملات المفعّلة في النظام' })
  findAll() {
    return this.currenciesService.findAll();
  }

  @ApiBearerAuth()
  @Post()
  @Roles(StaffRole.ADMIN)
  @ApiOperation({ summary: 'تسجيل عملة جديدة' })
  create(@Body() dto: CreateCurrencyDto) {
    return this.currenciesService.create(dto);
  }
}
