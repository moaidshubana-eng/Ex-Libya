import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

export class CreateCurrencyDto {
  @ApiProperty({ example: 'USD', description: 'رمز ISO 4217' })
  @IsString()
  @Length(3, 3)
  code!: string;

  @ApiProperty({ example: 'دولار أمريكي' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 2, default: 2 })
  @IsInt()
  @Min(0)
  @Max(6)
  decimalPlaces = 2;
}
